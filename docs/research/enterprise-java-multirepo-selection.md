# Enterprise Java multi-repository QA fixture selection

Research snapshot: 2026-08-28. Only first-party repository metadata, source,
build files, and project documentation were used.

## Recommendation: Kill Bill's four core repositories

Use these repositories at their default `master` branches:

| Repository | Role | Build | Last push observed | GitHub `size` | Files / Java files |
| --- | --- | --- | --- | ---: | ---: |
| [`killbill/killbill`](https://github.com/killbill/killbill) | Subscription billing and payments implementation | Maven | 2026-08-22 | 682,597 KB | 2,087 / 1,698 |
| [`killbill/killbill-api`](https://github.com/killbill/killbill-api) | Public Java domain contracts | Maven | 2026-07-10 | 1,097 KB | 234 / 209 |
| [`killbill/killbill-commons`](https://github.com/killbill/killbill-commons) | Shared state-machine, time, queue, database, and locking mechanics | Maven | 2026-07-28 | 4,516 KB | 1,216 / 1,084 |
| [`killbill/killbill-platform`](https://github.com/killbill/killbill-platform) | Runtime lifecycle, service discovery, OSGi/plugin, and server platform | Maven | 2026-07-29 | 234,053 KB | 308 / 206 |

The default branch, non-archived state, latest push, primary language, and
repository-size values come from the first-party GitHub repository objects:
[`killbill`](https://api.github.com/repos/killbill/killbill),
[`killbill-api`](https://api.github.com/repos/killbill/killbill-api),
[`killbill-commons`](https://api.github.com/repos/killbill/killbill-commons), and
[`killbill-platform`](https://api.github.com/repos/killbill/killbill-platform).
At the research snapshot all four were non-archived and had received a push
within the preceding seven weeks.
The file counts above were calculated from each default branch's non-truncated
recursive Git tree: [`killbill`](https://api.github.com/repos/killbill/killbill/git/trees/master?recursive=1),
[`api`](https://api.github.com/repos/killbill/killbill-api/git/trees/master?recursive=1),
[`commons`](https://api.github.com/repos/killbill/killbill-commons/git/trees/master?recursive=1), and
[`platform`](https://api.github.com/repos/killbill/killbill-platform/git/trees/master?recursive=1).
The four trees contain 3,845 files and 3,197 Java files in total. GitHub's
language API also identifies Java as the overwhelming source
language in all four repositories: [`killbill`](https://api.github.com/repos/killbill/killbill/languages),
[`api`](https://api.github.com/repos/killbill/killbill-api/languages),
[`commons`](https://api.github.com/repos/killbill/killbill-commons/languages), and
[`platform`](https://api.github.com/repos/killbill/killbill-platform/languages).

This is a real multi-repository product, not an arbitrary framework bundle.
The project's own README says the code is split across many components and
describes the product as a modular subscription-billing and payments platform
used by SaaS and e-commerce organizations ([source](https://github.com/killbill/killbill/blob/master/README.md)).
All four projects are Maven builds: their root
[`pom.xml`](https://github.com/killbill/killbill/blob/master/pom.xml) files use
the shared `killbill-oss-parent`.

The cross-repository edges are present in source build contracts:

- The main repository is divided into `account`, `catalog`, `subscription`,
  `entitlement`, `invoice`, `overdue`, `payment`, `usage`, `tenant`, and other
  Maven modules ([root POM](https://github.com/killbill/killbill/blob/master/pom.xml)).
- Its internal API module directly depends on `killbill-api`,
  `killbill-platform-api`, and commons artifacts such as `killbill-clock`,
  `killbill-jdbi`, and `killbill-queue`
  ([module POM](https://github.com/killbill/killbill/blob/master/api/pom.xml)).
- A concrete domain module such as account depends on the public API, platform
  API/test support, and commons clock, embedded database, JDBI, metrics, queue,
  and utility artifacts
  ([account POM](https://github.com/killbill/killbill/blob/master/account/pom.xml)).
- The public API repository contains the domain vocabulary itself: account,
  catalog plan/phase/pricing, entitlement/subscription events, invoices,
  payments, and usage
  ([API source tree](https://github.com/killbill/killbill-api/tree/master/src/main/java/org/killbill/billing)).
- Commons explicitly supplies automata, clocks, persistent event/notification
  queues, locking, JDBI, and XML loading
  ([commons README](https://github.com/killbill/killbill-commons/blob/master/README.md));
  platform supplies lifecycle, service discovery, OSGi/plugin, and container
  integration
  ([platform README](https://github.com/killbill/killbill-platform/blob/master/README.md)).

### Why it is the best repo-wiki QA fixture

The set exposes a useful four-layer test:

1. `killbill-api` defines stable business concepts and boundaries.
2. `killbill` implements interacting billing lifecycles across domain modules.
3. `killbill-commons` supplies the time, event, persistence, and state-machine
   mechanisms used by those lifecycles.
4. `killbill-platform` supplies runtime and extension mechanics.

A good generated Wiki should therefore explain concepts such as catalog plans
and phases, subscription versus entitlement, invoice generation and
adjustments, payment attempts, overdue handling, and usage billing, then connect
them to clocks, queues, automata, lifecycle, and plugin boundaries. It should not
turn every Maven module into a page or mislabel commons/platform infrastructure
as business domains. The separate `killbill-api` repository and the main
repository's internal `api` module also provide a valuable ambiguity test: the
Wiki must distinguish public domain contracts from internal service contracts.

### Disk-budget qualification

The four GitHub `size` fields total 922,263 KB, about 901 MiB. That field is a
repository-level planning signal, not a prediction of the exact shallow-clone
checkout size. Use `--depth=1 --no-tags`, measure each repository with `du`, and
check free space before starting repo-wiki. Stop before 1.6 GiB to retain room
for `.okf-wiki`, generated artifacts, and Codex logs. If the checkout exceeds
that threshold, omit `killbill-platform` first; the remaining three repositories
still preserve the public-contract, implementation, and shared-mechanics test.

## Alternatives considered

### Axelor: strongest ERP alternative

`axelor-open-suite` is explicitly built on
[`axelor-open-platform`](https://github.com/axelor/axelor-open-platform), and its
official README lists CRM, sales, finance, HR, projects, inventory/supply chain,
production, multi-company, and multi-currency modules
([source](https://github.com/axelor/axelor-open-suite/blob/master/README.md)).
The suite's [source tree](https://api.github.com/repos/axelor/axelor-open-suite/git/trees/master?recursive=1)
contains 7,847 files and 4,099 Java files, while the platform's
[source tree](https://api.github.com/repos/axelor/axelor-open-platform/git/trees/main?recursive=1)
contains 2,262 files and 944 Java files. The official
[`open-suite-webapp`](https://github.com/axelor/open-suite-webapp) composes the
suite as a Git submodule and applies the Axelor Gradle application plugin
([settings](https://github.com/axelor/open-suite-webapp/blob/master/settings.gradle),
[build](https://github.com/axelor/open-suite-webapp/blob/master/build.gradle)).

This is an excellent package/module-scaling test, but a weaker first
cross-repository semantic test: most business concepts live in one large suite
repository, while the other repositories are framework and assembly layers.
Axelor also expresses substantial domain and view structure in XML, so a poor
result would conflate Java-domain extraction quality with non-Java indexing.
Metadata and activity are available from the official repository objects:
[`platform`](https://api.github.com/repos/axelor/axelor-open-platform),
[`suite`](https://api.github.com/repos/axelor/axelor-open-suite), and
[`webapp`](https://api.github.com/repos/axelor/open-suite-webapp).

### Apache Fineract plus Mifos plugins: strongest single-repo banking test

Apache Fineract describes itself as an extensible core banking platform and
builds with Gradle ([README](https://github.com/apache/fineract/blob/develop/README.md),
[`build.gradle`](https://github.com/apache/fineract/blob/develop/build.gradle)).
Its default [`develop` tree](https://api.github.com/repos/apache/fineract/git/trees/develop?recursive=1)
alone contains 8,079 files and 6,739 Java files, with modules for loans,
savings, accounting, tax, rates, investor flows, security, COB processing, and
reporting. Mifos maintains Java repositories that explicitly
integrate with it, including the
[`mifos-reporting-plugin`](https://github.com/openMF/mifos-reporting-plugin) and
[`mifos-security-plugin`](https://github.com/openMF/mifos-security-plugin).

This is the best candidate for stressing deep banking terminology and sheer
repository scale. It is not the first choice for this run because nearly all
of the domain model remains in the Fineract monorepo; the related repositories
are peripheral plugins, so cross-repository synthesis is less demanding than
Kill Bill's API/implementation/commons/platform split. Activity and default
branch evidence: [`apache/fineract`](https://api.github.com/repos/apache/fineract),
[`reporting plugin`](https://api.github.com/repos/openMF/mifos-reporting-plugin),
and [`security plugin`](https://api.github.com/repos/openMF/mifos-security-plugin).

### Moqui: domain-rich, but not a Java-focused fixture

Moqui has a genuine multi-repository composition: the framework requires a
separate runtime, while Mantle separates its universal data model and service
library ([framework README](https://github.com/moqui/moqui-framework/blob/master/README.md),
[`mantle-udm`](https://github.com/moqui/mantle-udm),
[`mantle-usl`](https://github.com/moqui/mantle-usl)). It is valuable for testing
declarative enterprise models, but not for this Java QA: GitHub identifies the
framework primarily as Groovy, the UDM is mostly XML, and the current
[`MarbleERP`](https://github.com/moqui/MarbleERP) repository is very small.

## Selection

Run Kill Bill first. It is the only candidate here that combines substantial
Java domain code, four active first-party repositories, explicit build-time
edges among them, and distinct contract, implementation, shared-mechanism, and
runtime layers within the requested disk envelope. Use Axelor next when the
specific question becomes whether repo-wiki can avoid page explosion across a
large ERP module tree.
