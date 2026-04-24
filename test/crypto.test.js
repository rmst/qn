import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:crypto shim', () => {
	/* ---- Hashing ---- */

	test('createHash sha256 hex digest matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('hello world').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 with empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		})
	})

	test('createHash sha256 with unicode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('日本語テスト').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '4b09dffafb42f5b069c66a0283523c0e85c9af2a5530a8fbd541b3e5f9a9c7cd'
		})
	})

	test('createHash sha256 multiple updates', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256')
				.update('hello')
				.update(' ')
				.update('world')
				.digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 long input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const longString = 'a'.repeat(10000)
			const hash = createHash('sha256').update(longString).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '27dd1f61b867b6a0f6e9d8a41c43231de52107e53ae424de8f847b821db4b711'
		})
	})

	test('createHash with binary output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('test').digest()
			console.log(JSON.stringify({ length: hash.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.length, 32)
	})

	test('createHash sha256 with Buffer input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const buf = Buffer.from('hello world')
			const hash = createHash('sha256').update(buf).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 with Uint8Array input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const arr = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
			const hash = createHash('sha256').update(arr).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
		})
	})

	test('createHash sha256 mixed string and buffer updates', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256')
				.update('hello')
				.update(Buffer.from(' '))
				.update('world')
				.digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 digest can be called without encoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('abc').digest()
			// Known SHA-256 of "abc"
			const expected = [
				0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
				0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
				0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
				0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
			]
			const match = hash.length === 32 && expected.every((b, i) => hash[i] === b)
			console.log(JSON.stringify({ match }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('createHash md5', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('md5').update('hello').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '5d41402abc4b2a76b9719d911017c592'
		})
	})

	test('createHash sha1', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha1').update('hello').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'
		})
	})

	test('createHash sha384', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha384').update('hello').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '59e1748777448c69de6b800d7a33bbfb9ff1b463e44354c3553bcdb9c666fa90125a3c79f90397bdf5f6a13de828684f'
		})
	})

	test('createHash sha512', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha512').update('hello').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043'
		})
	})

	/* ---- HMAC ---- */

	test('createHmac sha256', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHmac } from 'node:crypto'
			const h = createHmac('sha256', 'secret').update('hello').digest('hex')
			console.log(JSON.stringify({ h }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			h: '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b'
		})
	})

	test('createHmac sha256 incremental', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHmac } from 'node:crypto'
			const h = createHmac('sha256', 'secret').update('hel').update('lo').digest('hex')
			console.log(JSON.stringify({ h }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			h: '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b'
		})
	})

	test('createHmac sha1', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHmac } from 'node:crypto'
			const h = createHmac('sha1', 'key').update('message').digest('hex')
			console.log(JSON.stringify({ len: h.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { len: 40 })
	})

	test('createHmac with Buffer key', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHmac } from 'node:crypto'
			const h = createHmac('sha256', Buffer.from('secret')).update('hello').digest('hex')
			console.log(JSON.stringify({ h }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			h: '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b'
		})
	})

	/* ---- AES-CTR ---- */

	test('aes-256-ctr roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
			const key = randomBytes(32), iv = randomBytes(16)
			const cipher = createCipheriv('aes-256-ctr', key, iv)
			const enc = cipher.update('hello world')
			cipher.final()
			const decipher = createDecipheriv('aes-256-ctr', key, iv)
			const dec = decipher.update(enc)
			decipher.final()
			console.log(JSON.stringify({ ok: dec.toString('utf8') === 'hello world', encLen: enc.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true, encLen: 11 })
	})

	test('aes-128-ctr roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
			const key = randomBytes(16), iv = randomBytes(16)
			const cipher = createCipheriv('aes-128-ctr', key, iv)
			const enc = cipher.update('test data 12345')
			cipher.final()
			const decipher = createDecipheriv('aes-128-ctr', key, iv)
			const dec = decipher.update(enc)
			decipher.final()
			console.log(JSON.stringify({ ok: dec.toString('utf8') === 'test data 12345' }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true })
	})

	/* ---- AES-GCM ---- */

	test('aes-256-gcm roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
			const key = randomBytes(32), iv = randomBytes(12)
			const cipher = createCipheriv('aes-256-gcm', key, iv)
			cipher.setAAD(Buffer.from('aad'))
			const enc = cipher.update('hello gcm')
			cipher.final()
			const tag = cipher.getAuthTag()

			const decipher = createDecipheriv('aes-256-gcm', key, iv)
			decipher.setAAD(Buffer.from('aad'))
			const dec = decipher.update(enc)
			decipher.setAuthTag(tag)
			decipher.final()
			console.log(JSON.stringify({ ok: dec.toString('utf8') === 'hello gcm', tagLen: tag.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true, tagLen: 16 })
	})

	test('aes-256-gcm bad auth tag throws', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
			const key = randomBytes(32), iv = randomBytes(12)
			const cipher = createCipheriv('aes-256-gcm', key, iv)
			const enc = cipher.update('data')
			cipher.final()

			const decipher = createDecipheriv('aes-256-gcm', key, iv)
			decipher.update(enc)
			decipher.setAuthTag(Buffer.alloc(16, 0xff))
			let threw = false
			try { decipher.final() } catch { threw = true }
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	/* ---- ChaCha20-Poly1305 ---- */

	testQnOnly('chacha20-poly1305 roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
			const key = randomBytes(32), iv = randomBytes(12)
			const cipher = createCipheriv('chacha20-poly1305', key, iv)
			cipher.setAAD(Buffer.from('aad'))
			cipher.update('hello chapoly')
			const enc = cipher.final()
			const tag = cipher.getAuthTag()

			const decipher = createDecipheriv('chacha20-poly1305', key, iv)
			decipher.setAAD(Buffer.from('aad'))
			decipher.update(enc)
			decipher.setAuthTag(tag)
			const dec = decipher.final()
			console.log(JSON.stringify({ ok: dec.toString('utf8') === 'hello chapoly', tagLen: tag.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true, tagLen: 16 })
	})

	/* ---- ECDH ---- */

	test('ecdh prime256v1 key agreement', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createECDH } from 'node:crypto'
			const alice = createECDH('prime256v1')
			alice.generateKeys()
			const bob = createECDH('prime256v1')
			bob.generateKeys()
			const sa = alice.computeSecret(bob.getPublicKey()).toString('hex')
			const sb = bob.computeSecret(alice.getPublicKey()).toString('hex')
			console.log(JSON.stringify({ match: sa === sb, len: sa.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true)
		assert.ok(result.len > 0)
	})

	test('ecdh secp384r1 key agreement', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createECDH } from 'node:crypto'
			const alice = createECDH('secp384r1')
			alice.generateKeys()
			const bob = createECDH('secp384r1')
			bob.generateKeys()
			const sa = alice.computeSecret(bob.getPublicKey()).toString('hex')
			const sb = bob.computeSecret(alice.getPublicKey()).toString('hex')
			console.log(JSON.stringify({ match: sa === sb, len: sa.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true)
		assert.ok(result.len > 0)
	})

	/* ---- ECDSA ---- */

	testQnOnly('ecdsa sign and verify', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createECDH, createSign, createVerify } from 'node:crypto'
			const ec = createECDH('prime256v1')
			ec.generateKeys()

			const signer = createSign('sha256')
			signer.update('test message')
			const sig = signer.sign({ key: ec.getPrivateKey(), curve: 'prime256v1' })

			const verifier = createVerify('sha256')
			verifier.update('test message')
			const ok = verifier.verify({ key: ec.getPublicKey(), curve: 'prime256v1' }, sig)

			const verifier2 = createVerify('sha256')
			verifier2.update('wrong message')
			const notOk = verifier2.verify({ key: ec.getPublicKey(), curve: 'prime256v1' }, sig)

			console.log(JSON.stringify({ ok, notOk }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true, notOk: false })
	})

	/* ---- Random ---- */

	test('randomBytes returns correct length', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { randomBytes } from 'node:crypto'
			console.log(JSON.stringify({
				a: randomBytes(16).length,
				b: randomBytes(32).length,
				c: randomBytes(0).length,
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { a: 16, b: 32, c: 0 })
	})

	test('randomUUID format', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { randomUUID } from 'node:crypto'
			const uuid = randomUUID()
			const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
			console.log(JSON.stringify({ valid }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { valid: true })
	})

	/* ---- timingSafeEqual ---- */

	test('timingSafeEqual', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { timingSafeEqual } from 'node:crypto'
			const eq = timingSafeEqual(Buffer.from('hello'), Buffer.from('hello'))
			const neq = timingSafeEqual(Buffer.from('hello'), Buffer.from('world'))
			let threw = false
			try { timingSafeEqual(Buffer.from('ab'), Buffer.from('abc')) } catch { threw = true }
			console.log(JSON.stringify({ eq, neq, threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { eq: true, neq: false, threw: true })
	})

	/* ---- Introspection ---- */

	testQnOnly('getHashes, getCiphers, getCurves', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { getHashes, getCiphers, getCurves } from 'node:crypto'
			const h = getHashes(), c = getCiphers(), cu = getCurves()
			console.log(JSON.stringify({
				hasSha256: h.includes('sha256'),
				hasMd5: h.includes('md5'),
				hasAesGcm: c.includes('aes-256-gcm'),
				hasChapoly: c.includes('chacha20-poly1305'),
				hasP256: cu.includes('prime256v1'),
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasSha256: true, hasMd5: true, hasAesGcm: true,
			hasChapoly: true, hasP256: true,
		})
	})
})
