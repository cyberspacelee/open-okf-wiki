# Inspect

Read only the Source root from the dispatch packet: top-level shape, build
manifests and README title block. Do not deeply read implementation.

Write the artifact as JSON:

    {
      "source": "api",
      "survey_targets": [
        {"id": "api-core", "source": "api", "scope": ["src", "tests"]}
      ]
    }

Target ids are globally unique lowercase slugs. Split only real monorepos or
unrelated products; otherwise create one survey target.

Handoff: artifact path and target count.
