# Build one bundle from a versioned source set

A Producer Project may combine multiple named repositories—such as implementation, requirements, and shared contracts—into one Knowledge Bundle, and each Production Run pins a Source Set containing an exact revision for every source. Evidence identities include source, revision, path, and span; coverage and classification respect source roles, conflicts remain explicit, and incremental invalidation follows only changed snapshots and their Knowledge Impact Graph, while separate Producer Projects still run independently.
