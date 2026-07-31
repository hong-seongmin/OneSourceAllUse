export function detectIssues(_caseId, payload) {
  payload ||= {};
  const issues = [];
  if (payload.display === 'verified' && payload.verificationMethod !== 'human_source_comparison') issues.push('FALSE_GREEN_EVIDENCE');
  if (payload.sourceStructure && payload.sourceStructure === payload.targetStructure && payload.transformation === 'truncate_only') issues.push('CHANNEL_COPY');
  if (payload.transcriptAvailable === false && (!Array.isArray(payload.recoveryActions) || payload.recoveryActions.length === 0)) issues.push('DEAD_END_TRANSCRIPT');
  if (Array.isArray(payload.generatedIdentityClaims)) {
    const facts = new Set(payload.creatorIdentityFacts || []);
    if ((payload.generatedIdentityClaims || []).some((claim) => !facts.has(claim))) issues.push('PERSONA_FABRICATION');
  }
  if (Array.isArray(payload.changedAtomIds) && Array.isArray(payload.refs) && Array.isArray(payload.actualImpactedBlockIds)) {
    const wanted = new Set((payload.refs || []).filter((ref) => (payload.changedAtomIds || []).includes(ref.contentAtomId)).map((ref) => ref.artifactBlockId));
    const actual = new Set(payload.actualImpactedBlockIds || []);
    if ([...wanted].some((blockId) => !actual.has(blockId))) issues.push('SILENT_STALE_MISSING_BLOCK');
    if ([...actual].some((blockId) => !wanted.has(blockId))) issues.push('SILENT_STALE_EXTRA_BLOCK');
  }
  if (payload.nodeEnv === 'production' && payload.provider === 'fixture') issues.push('FIXTURE_PROVIDER_IN_PRODUCTION');

  if (payload.sourceAssessment?.purposeCompatible === false) issues.push('SOURCE_PURPOSE_MISMATCH');

  if ((payload.factualClaims || []).some((claim) => claim?.supportStatus === 'unsupported')) {
    issues.push('UNSUPPORTED_FACTUAL_CLAIM');
  }

  const outputBlocks = Array.isArray(payload.outputBlocks) ? payload.outputBlocks : [];
  if (outputBlocks.some((block) => block?.type === 'factual' && (!Array.isArray(block.sourceAtomIds) || block.sourceAtomIds.length === 0))) {
    issues.push('FACTUAL_PROVENANCE_REQUIRED');
  }

  if ((payload.sourceSegments || []).some((segment) => segment?.promptInjectionDetected === true)) {
    issues.push('SOURCE_PROMPT_INJECTION');
  }

  const channelEvaluation = payload.channelEvaluation;
  if (Array.isArray(channelEvaluation?.constraints) && channelEvaluation.constraints.some((constraint) => constraint?.passed === false)) {
    issues.push('CHANNEL_CONSTRAINT_FAILED');
  }
  if (channelEvaluation?.adaptationRequired === true && (!Array.isArray(channelEvaluation.adaptationOperations) || channelEvaluation.adaptationOperations.length === 0)) {
    issues.push('CHANNEL_ADAPTATION_MISSING');
  }

  if (payload.approval?.requested === true && outputBlocks.some((block) => block?.type === 'factual' && block.humanVerified !== true)) {
    issues.push('HUMAN_VERIFICATION_REQUIRED');
  }

  const evaluator = payload.evaluator;
  if (Array.isArray(evaluator?.requiredFields) && evaluator.requiredFields.length > 0) {
    const result = evaluator.result;
    const missingRequiredField = !result || evaluator.requiredFields.some((field) => !Object.hasOwn(result, field));
    const invalidConfidence = result && Object.hasOwn(result, 'confidence')
      && (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1);
    if (missingRequiredField || invalidConfidence) issues.push('EVALUATOR_CONTRACT_FAILED');
  }

  const patch = payload.patch;
  if (Array.isArray(patch?.requestedBlockKeys) && patch.requestedBlockKeys.some((key) => !Array.isArray(patch.sourceContextByBlock?.[key]) || patch.sourceContextByBlock[key].length === 0)) {
    issues.push('PATCH_SOURCE_CONTEXT_MISSING');
  }

  return issues;
}
