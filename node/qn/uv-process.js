/*
 * qn:uv-process - Typed JS wrappers over the single-dispatch C _op function.
 *
 * This module is the JS-side API for qn_uv_process.
 */

import {
	_op,
	SPAWN, KILL, GET_PID, SET_ON_EXIT, CLOSE,
} from 'qn_uv_process'

export const spawn     = (file, args, options) => _op(SPAWN, file, args, options)
export const kill      = (handle, signal) => _op(KILL, handle, signal)
export const getPid    = (handle) => _op(GET_PID, handle)
export const setOnExit = (handle, fn) => _op(SET_ON_EXIT, handle, fn)
export const close     = (handle) => _op(CLOSE, handle)
