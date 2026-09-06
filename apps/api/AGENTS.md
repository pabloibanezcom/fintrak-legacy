# Postman synchronization

The source of truth for Postman requests is `Fintrak-API.postman_collection.json`.
Keep all documentation and examples in English.

For every public API change, update the collection in the same change:
- Methods, paths, query parameters, request bodies and file uploads.
- Authentication, required headers and response examples.
- Shared contract changes under `packages/types/src`.
- Preserve existing request IDs, folders, scripts and environment placeholders where applicable.
- Use placeholder credentials and synthetic examples, never bank extracts or real financial data.

The GitHub workflow publishes this file to Postman after changes to `apps/api/**`
or `packages/types/**` reach `main`. It can also be run manually on `main`.
This publishes the checked-in collection; it does not infer new requests or
payloads from TypeScript. Updating the collection is part of implementing an
API change, as in Match Day Five.

Configure these repository Actions secrets before enabling publication:
- `POSTMAN_API_KEY`: a Postman API key with access to the destination collection.
- `POSTMAN_COLLECTION_ID`: the UID of the dedicated Fintrak collection, not the
  Match Day Five collection. The placeholder `info._postman_id` in the local
  export is not the cloud collection UID.

Import the existing Fintrak collection into Postman if it does not exist.
The sync replaces the selected cloud collection, including its variables and
scripts. Keep personal values in a Postman environment and make shared request
changes in the repository. Do not put personal values in the checked-in file.

Workflow: `../../.github/workflows/postman-sync.yml`.
