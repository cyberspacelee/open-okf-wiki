# Configure a Repository Snapshot Set without storing secrets

A Wiki Run may combine one or more named repositories into one Repository Snapshot Set. Non-secret inputs live in a versioned YAML run configuration; each configured branch is resolved once to an exact commit before model work, explicit standard-library `fnmatch` patterns filter tracked POSIX paths, and publication metadata records every resolved repository. Provider credentials and secret headers remain outside YAML and enter only through process environment variables or a secret manager, following OpenAI's guidance to avoid storing API keys in code or public repositories. For local CLI use, `.env` beside the run configuration, or in the current directory as a fallback, populates missing environment variables without overriding externally supplied values.

## Local provider environment

The CLI loads one local `.env` file for convenience: the file beside `wiki-run --config` wins when
present; otherwise the current directory is used. `load_dotenv` never overrides existing process
variables, and `PYTHON_DOTENV_DISABLED=1` disables local loading. This keeps local setup short while
leaving CI, deployments, and secret managers authoritative.
