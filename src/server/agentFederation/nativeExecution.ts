import { createHash } from 'node:crypto'
import type { NativeConversion, NativeExecutionProfile, NativeOutputVerification } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { contentDigest } from './provider/protocol.js'

/** Current experimental owner bindings; never advertises stable six-family activation. */
export function nativeExecutionProfile(conversion: NativeConversion): NativeExecutionProfile {
  return { kind: 'NativeExecutionProfile', profile: 'native-independent-text-v1alpha1', conversion_id: conversion.id,
    spec_digest: conversion.spec_digest, definition_digest: conversion.image.definition_digest, image_id: conversion.image.image_id,
    runtime: conversion.image.runtime, task_contract_version: 'task.sudo.dev/v1alpha1', task_policy: 'independent_turns',
    tool_policy: 'deny_all', context_policy: 'literal_synthetic_text', memory_policy: 'disabled',
    verify_policy: 'native-text-completion-v1', event_contract_version: 'task.sudo.dev/v1alpha1' }
}

/** Matches Nexus native_execution.verify_output. Business correctness stays with the rubric. */
export function verifyNativeOutput(profile: NativeExecutionProfile, answer: string, callIds: string[],
  trace: { node: string; phase: string }[], succeeded: boolean, cleaned: boolean): Required<NativeOutputVerification> {
  const failures: NativeOutputVerification['failures'] = []
  const malformed = [...answer].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff })
  if (!answer.replace(/[ \t\r\n\v\f]/g, '') || Buffer.byteLength(answer) > 128000 || answer.includes('\0') || malformed) failures.push('output_text')
  if (callIds.length !== 1) failures.push('model_call_count')
  if (trace.length !== 2 || trace[0].node !== 'native-sudocode' || trace[0].phase !== 'started'
    || trace[1].node !== 'native-sudocode' || trace[1].phase !== 'completed') failures.push('native_trace')
  if (!succeeded || !cleaned) failures.push('execution_cleanup')
  return { kind: 'NativeOutputVerification', policy: 'native-text-completion-v1', profile_digest: contentDigest(profile),
    output_digest: `sha256:${createHash('sha256').update(answer).digest('hex')}`, verdict: failures.length ? 'rejected' : 'passed', failures }
}
