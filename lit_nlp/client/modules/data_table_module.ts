/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// tslint:disable:no-new-decorators
import '../elements/checkbox';
import '../elements/popup_container';

import {html} from 'lit';
import {customElement, query} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';
import {computed, observable} from 'mobx';

import {app} from '../core/app';
import {LitModule} from '../core/lit_module';
import {ColumnHeader, DataTable, SortableTemplateResult, TableData, TableEntry} from '../elements/table';
import {BooleanLitType, LitType, LitTypeWithVocab, URLLitType} from '../lib/lit_types';
import {styles as sharedStyles} from '../lib/shared_styles.css';
import {formatForDisplay, IndexedInput, ModelInfoMap, Spec} from '../lib/types';
import {compareArrays} from '../lib/utils';
import {DataService, FocusService, SelectionService, SliceService} from '../services/services';
import {STARRED_SLICE_NAME} from '../services/slice_service';

import {styles} from './data_table_module.css';

type ColWidths = [minWidth?: number, maxWidth?: number];
/** A map of LitType class names to their minimum and maximum widths, in px.  */
const LIT_TYPE_MIN_MAX_WIDTHS: {[key: string]: ColWidths} = {
  "TextSegment": [220, 600],
  "CategoryLabel": [60, 100],
  "BooleanLitType": [60, 100],
  "MulticlassPreds": [60, 200],
  "Scalar": [60, 100],
  "RegressionScore": [60, 100],
  "ImageBytes": [60, undefined],
  "SearchQuery": [100, 300],
  "Tokens": [220, 600],
  "SequenceTags": [100, 600],
  "SpanLabels": [150, 200],
  "EdgeLabels": [150, 200],
  "MultiSegmentAnnotations": [60, 200],
  "GeneratedTextCandidates": [150, 400]
};

// TODO(b/275101197): consolidate this with other rendering code.
// This is here for now as formatForDisplay() only returns a string.
function formatForTable(
    input: unknown, fieldSpec?: LitType, limitWords?: boolean): TableEntry {
  if (fieldSpec instanceof URLLitType) {
    // Prevent clicking the URL from selecting or de-selecting the table row.
    const stopClickThrough = (e: Event) => {
      e.stopPropagation();
    };
    // clang-format off
    const template = html`
      <a href=${input as string} target="_blank"
       @click=${stopClickThrough}>${input as string}</a>`;
    // clang-format on
    return {template, value: (input as string)} as SortableTemplateResult;
  }

  return formatForDisplay(input, fieldSpec, limitWords);
}

/**
 * A LIT module showing a table containing the InputData examples. Allows the
 * user to sort, filter, and select examples.
 */
@customElement('data-table-module')
export class DataTableModule extends LitModule {
  static override title = 'Data Table';
  static override template =
      (model: string, selectionServiceIndex: number, shouldReact: number) => html`
      <data-table-module model=${model} .shouldReact=${shouldReact}
        selectionServiceIndex=${selectionServiceIndex}>
      </data-table-module>`;
  static override numCols = 4;
  static override get styles() {
    return [sharedStyles, styles];
  }

  static override duplicateForModelComparison = false;

  protected showControls = true;

  private readonly focusService = app.getService(FocusService);
  private readonly dataService = app.getService(DataService);
  private readonly sliceService = app.getService(SliceService);
  private readonly referenceSelectionService =
      app.getService(SelectionService, 'pinned');

  @observable columnVisibility = new Map<string, boolean>();
  @observable globalSearchText = '';
  // If text box has been edited but not yet applied.
  @observable globalSearchEdited = false;

  // Module options / configuration state
  @observable private onlyShowGenerated = false;
  @observable private onlyShowSelected = false;

  // Child components
  @query('lit-data-table') private readonly table?: DataTable;

  @computed
  get dataSpec(): Spec {
    return this.appState.currentDatasetSpec;
  }

  // Column names from the current data for the data table.
  @computed
  get keys(): ColumnHeader[] {
    function createColumnHeader(name: string, type: LitType) {
      const [minWidth, maxWidth] = type.name in LIT_TYPE_MIN_MAX_WIDTHS ?
        LIT_TYPE_MIN_MAX_WIDTHS[type.name] : [];

      const header = {
        name,
        maxWidth,
        minWidth,
        width: maxWidth,
        vocab: (type as LitTypeWithVocab).vocab
      };

      if (type instanceof BooleanLitType) {
        header.vocab = ['✔', ' '];
      }
      return header;
    }

    // Use currentInputData to get keys / column names because filteredData
    // might have 0 length;
    const keyNames = this.appState.currentInputDataKeys;
    const keys =
        keyNames.map(key => createColumnHeader(key, this.dataSpec[key]));
    const dataKeys = this.dataService.cols.map(
        col => createColumnHeader(col.name, col.dataType));
    return keys.concat(dataKeys);
  }

  // Filtered keys that hide ones tagged as not to be shown by default in the
  // data table. The filtered ones can still be enabled through the "Columns"
  // selector dropdown.
  @computed
  get defaultKeys(): ColumnHeader[] {
    return this.keys.filter(feat => {
      const col = this.dataService.getColumnInfo(feat.name);
      if (col == null) {
        return true;
      }
      return col.dataType.show_in_data_table;
    });
  }

  // All columns to be available by default in the data table.
  @computed
  get defaultColumns(): ColumnHeader[] {
    return [{name: 'index', minWidth: 75, maxWidth: 105, width: 75},
      ...this.keys];
  }

  @computed
  get pinnedInputData(): IndexedInput[] {
    return this.appState.currentInputData.filter((inputData) => {
      return this.referenceSelectionService.primarySelectedId === inputData.id;
    });
  }

  @computed
  get filteredData(): IndexedInput[] {
    // Baseline data is either the selection or the whole dataset
    const data = this.onlyShowSelected ?
        this.selectionService.selectedInputData :
        this.appState.currentInputData;
    // Filter to only the generated datapoints, if desired
    return this.onlyShowGenerated ? data.filter((d) => d.meta.added) : data;
  }

  @computed
  get sortedData(): IndexedInput[] {
    // TODO(lit-dev): pre-compute the index chains for each point, since
    // this might get slow if we have a lot of counterfactuals.
    return this.filteredData.slice().sort(
        (a, b) => compareArrays(
            this.reversedAncestorIndices(a), this.reversedAncestorIndices(b)));
  }

  @computed
  get dataEntries(): TableEntry[][] {
    return this.sortedData.map((d) => {
      const index = this.appState.indicesById.get(d.id);
      if (index == null) return [];

      const dataEntries =
          this.keys.filter(k => this.columnVisibility.get(k.name))
              .map(
                  k => formatForTable(
                      this.dataService.getVal(d.id, k.name),
                      // TODO(b/283282667): Get field spec from Dataset or Model
                      // as appropriate for this column.
                      this.dataSpec[k.name]));
      return dataEntries;
    });
  }

  @computed
  get selectedRowIndices(): number[] {
    return this.sortedData
        .map((ex, i) => this.selectionService.isIdSelected(ex.id) ? i : -1)
        .filter(i => i !== -1);
  }

  @computed
  get tableDataIds(): string[] {
    return this.sortedData.map(d => d.id);
  }

  private indexOfId(id: string|null) {
    return id != null ? this.tableDataIds.indexOf(id) : -1;
  }

  @computed
  get primarySelectedIndex(): number {
    return this.indexOfId(this.selectionService.primarySelectedId);
  }

  @computed
  get referenceSelectedIndex(): number {
    if (this.appState.compareExamplesEnabled) {
      return this.indexOfId(this.referenceSelectionService.primarySelectedId);
    }
    return -1;
  }

  @computed
  get starredIndices(): number[] {
    const starredIds = this.sliceService.getSliceByName(STARRED_SLICE_NAME);
    if (starredIds) {
      return starredIds.map(sid => this.indexOfId(sid));
    }
    return [];
  }

  @computed
  get focusedIndex(): number {
    // Set focused index if a datapoint is focused according to the focus
    // service. If the focusData is null then nothing is focused. If focusData
    // contains a value in the "io" field then the focus is on a subfield of
    // a datapoint, as opposed to a datapoint itself.
    const focusData = this.focusService.focusData;
    return focusData == null || focusData.io != null ?
        -1 :
        this.indexOfId(focusData.datapointId);
  }

  /**
   * Recursively follow parent pointers and list their numerical indices.
   * Returns a list with the current index last, e.g.
   * [grandparent, parent, child]
   */
  private reversedAncestorIndices(d: IndexedInput): number[] {
    const ancestorIds = this.appState.getAncestry(d.id);
    // Convert to indices and return in reverse order.
    return ancestorIds.map((id) => this.appState.indicesById.get(id)!)
        .reverse();
  }

  private isStarred(id: string|null): boolean {
    return (id !== null) && this.sliceService.isInSlice(STARRED_SLICE_NAME, id);
  }

  private toggleStarred(id: string|null) {
    if (id == null) return;
    if (this.isStarred(id)) {
      this.sliceService.removeIdsFromSlice(STARRED_SLICE_NAME, [id]);
    } else {
      this.sliceService.addIdsToSlice(STARRED_SLICE_NAME, [id]);
    }
  }


  // TODO(lit-dev): figure out why this updates so many times;
  // it gets run _four_ times every time a new datapoint is added.
  @computed
  get tableData(): TableData[] {
    return this.dataEntries.map((dataEntry, i) => {
      const d = this.sortedData[i];
      const index = this.appState.indicesById.get(d.id);
      if (index == null) return [];

      const pinClick = (event: Event) => {
        const pinnedId = this.appState.compareExamplesEnabled ?
            this.referenceSelectionService.primarySelectedId :
            null;
        if (pinnedId === d.id) {
          this.appState.compareExamplesEnabled = false;
          this.referenceSelectionService.selectIds([]);
        } else {
          this.appState.compareExamplesEnabled = true;
          this.referenceSelectionService.selectIds([d.id]);
        }
        event.stopPropagation();
      };

      const starClick = (event: Event) => {
        this.toggleStarred(d.id);
        event.stopPropagation();
        event.preventDefault();
      };

      // Provide a template function for the 'index' column so that the
      // rendering can be based on the selection/hover state of the datapoint
      // represented by the row.
      function templateFn(
          isSelected: boolean, isPrimarySelection: boolean,
          isReferenceSelection: boolean, isFocused: boolean,
          isStarred: boolean) {
        const indexHolderDivStyle = styleMap({
          'display': 'flex',
          'justify-content': 'space-between',
          'width': '100%'
        });
        const indexButtonsDivStyle = styleMap({
          'display': 'flex',
          'flex-direction': 'row',
          'column-gap': '8px',
        });
        const indexDivStyle = styleMap({
          'text-align': 'right',
          'flex': '1',
        });
        // Render the action button next to the index if datapoint is selected,
        // hovered, or active (pinned, starred).
        function renderActionButtons() {
          function getActionStyle(isActive: boolean) {
            return styleMap({
              'visibility': isPrimarySelection || isFocused || isActive ?
                  'default' :
                  'hidden',
            });
          }

          function getActionClass(isActive: boolean) {
            return classMap({
              'icon-button': true,
              'cyea': true,
              'mdi-outlined': !isActive,
            });
          }

          if (isPrimarySelection || isFocused || isReferenceSelection ||
              isStarred) {
            // TODO(b/255799266): Add fast tooltips to icons.
            // There's an issue with table resizing and mwc-icon interactions.
            return html`
              <mwc-icon style="${getActionStyle(isReferenceSelection)}"
                class="${getActionClass(isReferenceSelection)}"
                @click=${pinClick}
                title=${`${isReferenceSelection ? 'Pin' : 'Unpin'} datapoint`}>
                push_pin
              </mwc-icon>
              <mwc-icon style="${getActionStyle(isStarred)}" @click=${starClick}
                class="${getActionClass(isStarred)}"
                title=${isStarred ? 'Remove from starred slice' :
                                    'Add to starred slice'}>
                ${isStarred ? 'star' : 'star_border'}
              </mwc-icon>`;
          }
          return null;
        }

        return html`
            <div style="${indexHolderDivStyle}">
              <div style=${indexButtonsDivStyle}>
               ${renderActionButtons()}
              </div>
              <div style="${indexDivStyle}">${index}</div>
            </div>`;
      }

      const indexEntry = {template: templateFn, value: index};
      return [indexEntry, ...dataEntry];
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    const updateColsChange = () =>
      [this.appState.currentModels, this.appState.currentDataset, this.keys];
    this.reactImmediately(updateColsChange, () => {this.updateColumns();});
  }

  private updateColumns() {
    const columnVisibility = new Map<string, boolean>();

    // Add default columns to the map of column names.
    for (const column of this.defaultColumns) {
      columnVisibility.set(
          column.name,
          this.defaultKeys.includes(column) || column.name === 'index');
    }
    this.columnVisibility = columnVisibility;
  }

  private datasetIndexToRowIndex(inputIndex: number): number {
    const indexedInput = this.appState.currentInputData[inputIndex];
    if (indexedInput == null) return -1;
    return this.sortedData.findIndex(d => d.id === indexedInput.id);
  }

  /**
   * Table callbacks receive indices corresponding to the rows of
   * this.tableData, which matches this.sortedData.
   * We need to map those back to global ids for selection purposes.
   */
  getIdFromTableIndex(tableIndex: number) {
    return this.sortedData[tableIndex]?.id;
  }

  onSelect(tableDataIndices: number[]) {
    const ids = tableDataIndices.map(i => this.getIdFromTableIndex(i))
                    .filter(id => id != null);
    this.selectionService.selectIds(ids, this);
  }

  onPrimarySelect(tableIndex: number) {
    const id = this.getIdFromTableIndex(tableIndex);
    this.selectionService.setPrimarySelection(id, this);
  }

  onHover(tableIndex: number|null) {
    if (tableIndex == null) {
      this.focusService.clearFocus();
    } else {
      const id = this.getIdFromTableIndex(tableIndex);
      this.focusService.setFocusedDatapoint(id);
    }
  }

  renderDropdownItem(key: string) {
    const checked = this.columnVisibility.get(key);
    if (checked == null) return;

    const toggleChecked = () => {
      this.columnVisibility.set(key, !checked);
    };

    // clang-format off
    return html`
      <div>
        <lit-checkbox class='column-select'
         label=${key} ?checked=${checked}
                      @change=${toggleChecked}>
        </lit-checkbox>
      </div>
    `;
    // clang-format on
  }

  renderColumnDropdown() {
    const names = [...this.columnVisibility.keys()].filter(c => c !== 'index');

    // clang-format off
    return html`
      <popup-container class='column-dropdown-container'>
        <button class='hairline-button' slot='toggle-anchor-closed'>
          &nbsp;Columns&nbsp;
          <span class='material-icon'>expand_more</span>
        </button>
        <button class='hairline-button' slot='toggle-anchor-open'>
          &nbsp;Columns&nbsp;
          <span class='material-icon'>expand_less</span>
        </button>
        <div class='column-dropdown'>
          ${names.map(key => this.renderDropdownItem(key))}
        </div>
      </popup-container>
    `;
    // clang-format on
  }

  renderControls() {
    const onClickResetView = () => {
      this.table?.resetView();
      this.globalSearchText = '';
    };

    const onClickSelectFiltered = () => {
      this.onSelect(this.table!.getVisibleDataIdxs());
    };
    const toggleSelectedCheckbox = () => {
      this.onlyShowSelected = !this.onlyShowSelected;
    };
    const toggleGeneratedCheckbox = () => {
      this.onlyShowGenerated = !this.onlyShowGenerated;
    };

    // clang-format off
    return html`
      ${this.renderColumnDropdown()}
      <div class="checkbox-row">
        <lit-checkbox label="Show selected"
                  ?checked=${this.onlyShowSelected}
                  @change=${toggleSelectedCheckbox}>
        </lit-checkbox>
        <lit-checkbox label="Show generated"
              ?checked=${this.onlyShowGenerated}
              @change=${toggleGeneratedCheckbox}>
        </lit-checkbox>
      </div>
      <div id="toolbar-buttons">
        <button class='hairline-button' @click=${onClickResetView}
          ?disabled="${this.table?.isDefaultView ?? true}">
          Reset view
        </button>
        <button class='hairline-button' @click=${onClickSelectFiltered}
          ?disabled="${!this.table?.isFiltered ?? true}">
          Select filtered
        </button>
      </div>
    `;
    // clang-format on
  }

  renderSearch() {
    const handleGlobalSearchInput = (e: KeyboardEvent) => {
      // Check for update, for highlighting purposes
      const searchQuery = (e.target as HTMLInputElement)?.value || '';
      this.globalSearchEdited = (searchQuery !== this.globalSearchText);
    };

    const handleGlobalSearchEnter = (e: KeyboardEvent) => {
      // Trigger an update on "enter" key.
      if(e.key=== "Enter") {
        const searchQuery = (e.target as HTMLInputElement)?.value || '';
        this.globalSearchText = searchQuery;
        this.globalSearchEdited = false;
      }
    };

    const containerClasses = classMap({
      'search-container': true,
      'search-container-edited': this.globalSearchEdited,
    });

    const tooltipContent = `Search using text, regex, numerical ranges,
      and column-name prefixes. Use AND and OR for joint queries. For example,
      'query AND ^query2 OR columnName:1-10.'`;
    return html`
      <div class=${containerClasses}>
        <mwc-icon class='icon material-icon-outlined'>search</mwc-icon>
        <div class='search-input-container'>
          <input type="search" id="search-input" .value=${this.globalSearchText}
            @input=${handleGlobalSearchInput}
            @keydown=${handleGlobalSearchEnter} placeholder="Search"/>
        </div>
        <lit-tooltip content=${tooltipContent}></lit-tooltip>
      </div>`;
  }

  renderTable() {
    const columnNames =
        this.defaultColumns.filter(col => this.columnVisibility.get(col.name));

    const shiftSelectStartRowIndex = this.datasetIndexToRowIndex(
        this.selectionService.shiftSelectionStartIndex);
    const shiftSelectEndRowIndex = this.datasetIndexToRowIndex(
        this.selectionService.shiftSelectionEndIndex);

    // clang-format off
    return html`
      <lit-data-table
        .data=${this.tableData}
        .columnNames=${columnNames}
        .selectedIndices=${this.selectedRowIndices}
        .primarySelectedIndex=${this.primarySelectedIndex}
        .referenceSelectedIndex=${this.referenceSelectedIndex}
        .starredIndices=${this.starredIndices}
        .focusedIndex=${this.focusedIndex}
        .headerTextMaxWidth=${150}
        .globalSearchText=${this.globalSearchText}
        .onSelect=${(idxs: number[]) => { this.onSelect(idxs); }}
        .onPrimarySelect=${(i: number) => { this.onPrimarySelect(i); }}
        .onHover=${(i: number|null)=> { this.onHover(i); }}
        searchEnabled
        selectionEnabled
        paginationEnabled
        exportEnabled
        showMoreEnabled
        shiftSelectionStartIndex=${shiftSelectStartRowIndex}
        shiftSelectionEndIndex=${shiftSelectEndRowIndex}
      ></lit-data-table>
    `;
    // clang-format on
  }

  override renderImpl() {
    // clang-format off
    return html`
      <div class='module-container'>
        ${this.showControls ? html`
          <div class='module-toolbar'>
            ${this.renderControls()}
          </div>
          <div class='module-toolbar'>
            ${this.renderSearch()}
          </div>` : null}
        <div class='module-results-area'>
          ${this.renderTable()}
        </div>
      </div>
    `;
    // clang-format on
  }

  static override shouldDisplayModule(
      modelSpecs: ModelInfoMap, datasetSpec: Spec) {
    return true;
  }
}

/**
 * Simplified version of the above; omits toolbar controls.
 */
@customElement('simple-data-table-module')
export class SimpleDataTableModule extends DataTableModule {
  protected override showControls = false;
  static override template = () => {
    return html`<simple-data-table-module></simple-data-table-module>`;
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'data-table-module': DataTableModule;
    'simple-data-table-module': SimpleDataTableModule;
  }
}
