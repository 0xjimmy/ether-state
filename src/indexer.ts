export { Indexer, callbackStore, defineIndex, indexChanges, runIndexChanges } from "./indexer/index.js"
export type {
	DuplicateIndexRow, FinalizedAnchor, FinalizedChainConflict, InconsistentIndexBundle, IndexBlockBundle,
	IndexBlockUnavailable, IndexCall, IndexChange, IndexCheckpoint, IndexCommit, IndexDefinition, IndexFinality,
	IndexMetadataMismatch, IndexReorgTooDeep, IndexRollback, IndexRow, IndexSource, IndexStore, IndexedBlock,
	IndexerError, IndexValue, InvalidIndexDefinition,
} from "./indexer/index.js"

export { Source, Projection } from "./indexer/model-definition.js"
export type { LogSource, ReadContext, ProjectionContext, SourceCaptureContext } from "./indexer/model-definition.js"
export { defineModel } from "./indexer/model.js"
export type { ModelDefinition, ModelInstance, ModelOptions, ModelPlan, ModelStatus, ProjectionUpdate, SourceUpdate } from "./indexer/model.js"
export { memoryModelStore, missingRange } from "./indexer/model-store.js"
export type { ModelStore, ModelFailure, ModelBatch, ModelCommit, BlockRange, ProjectionRow } from "./indexer/model-store.js"
