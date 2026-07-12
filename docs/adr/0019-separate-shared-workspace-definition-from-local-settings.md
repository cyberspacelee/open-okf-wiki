# Separate shared workspace definition from local settings

The GUI presents one Workspace settings experience but persists a shareable Workspace Definition separately from Local Workspace Settings. Sources, roles, revision policies, Producer Profile, and publication intent are portable; linked checkout paths, UI preferences, credentials, and other machine bindings remain local. Every Production Run records the fully resolved configuration snapshot so later audit does not depend on either mutable layer.
