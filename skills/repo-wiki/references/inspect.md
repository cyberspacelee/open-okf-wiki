# Inspect

Read only the Source root in the dispatch packet: top-level shape, build
manifests and README title block. Do not deeply read implementation.

Write the target artifact as JSON with this shape:

    {
      "source": "api",
      "survey_targets": [
        {"id": "api-core", "source": "api", "scope": ["src", "tests"]}
      ]
    }

Target ids are globally unique lowercase slugs. Split only real monorepos or
unrelated products; otherwise create one survey target. Complete with
'task complete inspect:source'.
