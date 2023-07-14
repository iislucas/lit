# Copyright 2020 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ==============================================================================
"""Tests for lit_nlp.components.thresholder."""

from absl.testing import absltest
from absl.testing import parameterized
from lit_nlp.api import dataset as lit_dataset
from lit_nlp.api import types as lit_types
from lit_nlp.components import thresholder
from lit_nlp.examples.models import glue_models
from lit_nlp.lib import caching  # for hash id fn


# TODO(b/254110131): Determine if we can use the file_cache.cached_path() in
# both google3 and OSS integration testing setups.
from lit_nlp.lib import file_cache
BERT_TINY_PATH = file_cache.cached_path(
    'https://storage.googleapis.com/what-if-tool-resources/lit-models/sst2_tiny.tar.gz',  # pylint: disable=line-too-long
    extract_compressed_file=True,
)


_EXAMPLES = [
    {'sentence': 'a', 'label': '1'},
    {'sentence': 'b', 'label': '1'},
    {'sentence': 'c', 'label': '1'},
    {'sentence': 'd', 'label': '1'},
    {'sentence': 'e', 'label': '1'},
    {'sentence': 'f', 'label': '0'},
    {'sentence': 'g', 'label': '0'},
    {'sentence': 'h', 'label': '0'},
    {'sentence': 'i', 'label': '0'}
]

_INDEXED_EXAMPLES = [
    {'id': caching.input_hash(ex), 'data': ex} for ex in _EXAMPLES
]


class ThresholderTest(parameterized.TestCase):

  @classmethod
  def setUpClass(cls):
    super().setUpClass()
    cls.model = caching.CachingModelWrapper(
        glue_models.SST2Model(BERT_TINY_PATH), 'test'
    )
    cls.dataset = lit_dataset.IndexedDataset(
        id_fn=caching.input_hash,
        spec={
            'sentence': lit_types.TextSegment(),
            'label': lit_types.CategoryLabel(vocab=['0', '1'])
        },
        indexed_examples=_INDEXED_EXAMPLES,
    )
    cls.model_outputs = list(
        cls.model.predict_with_metadata(_INDEXED_EXAMPLES, dataset_name='test')
    )

  def setUp(self):
    super().setUp()
    self.thresholder = thresholder.Thresholder()

  @parameterized.named_parameters(
      ('default', None, 0.71),
      ('cost_ratio_high', {'cost_ratio': 5, 'facets': {'': {}}}, 0.86),
      ('cost_ratio_low', {'cost_ratio': 0.2, 'facets': {'': {}}}, 0),
  )
  def test_thresholder(self, config: lit_types.JsonDict, expected: float):
    # Test with default options.
    result = self.thresholder.run_with_metadata(
        _INDEXED_EXAMPLES,
        self.model,
        self.dataset,
        self.model_outputs,
        config=config
    )
    self.assertLen(result, 1)
    self.assertEqual('probas', result[0]['pred_key'])
    self.assertEqual(expected, result[0]['thresholds']['']['Single'])

  def test_thresholder_with_facets(self):
    config = {
        'cost_ratio': 1,
        'facets': {
            'label:1': {'data': _INDEXED_EXAMPLES[0:5]},
            'label:0': {'data': _INDEXED_EXAMPLES[5:9]},
        }
    }
    result = self.thresholder.run_with_metadata(
        _INDEXED_EXAMPLES,
        self.model,
        self.dataset,
        self.model_outputs,
        config=config,
    )
    thresholds = result[0]['thresholds']
    self.assertEqual(0.71, thresholds['label:0']['Single'])
    self.assertEqual(0.71, thresholds['label:1']['Single'])
    self.assertEqual(0.86, thresholds['label:0']['Individual'])
    self.assertEqual(0, thresholds['label:1']['Individual'])
    self.assertEqual(0, thresholds['label:0']['Demographic parity'])


if __name__ == '__main__':
  absltest.main()