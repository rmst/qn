/**
 * qn:worker - Web Worker API wrapper over qn_worker C module
 *
 * Provides the standard Web Worker constructor:
 *   const w = new Worker('./worker.js')
 *   w.postMessage(data)
 *   w.onmessage = (event) => { ... }
 *   w.terminate()
 */

import { _create, _postMessage, _terminate, _setOnMessage, _setOnError } from 'qn_worker'

export class Worker {
	#handle
	#onmessage = null
	#onerror = null

	constructor(url) {
		if (typeof url !== 'string')
			throw new TypeError('Worker constructor: url must be a string')
		this.#handle = _create(url)
	}

	postMessage(message) {
		_postMessage(this.#handle, message)
	}

	terminate() {
		_terminate(this.#handle)
	}

	get onmessage() {
		return this.#onmessage
	}

	set onmessage(fn) {
		this.#onmessage = fn
		_setOnMessage(this.#handle, fn != null ? fn : undefined)
	}

	get onerror() {
		return this.#onerror
	}

	set onerror(fn) {
		this.#onerror = fn
		_setOnError(this.#handle, fn != null ? fn : undefined)
	}
}
