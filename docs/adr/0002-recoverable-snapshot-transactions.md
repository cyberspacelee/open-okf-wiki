# Recoverable Candidate install

Installing `wiki/` uses an atomic directory rename of the Candidate after OKF
validation. There is no opaque publication seal. Crash recovery is the
filesystem rename plus the Run record under `.okf-wiki/runs/<id>/`.
