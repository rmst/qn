import { execSync } from 'node:child_process'

export const run = {
	default: jix.script`

	`,
}


const binDir = () => {

	let repo = jix.git.checkout({
		repo: import.meta.dirname,
		commit: execSync('git rev-parse HEAD', { cwd: import.meta.dirname, encoding: 'utf8' }).trim()
	})

	// let repo = import.meta.dirname

	let platform = jix.target().host.os === "macos" ? "darwin" : "linux"

	return jix.build`
		cp -r "${repo}" ./repo
		cd repo
		make build
		mkdir -p "$out"
		cp ./bin/${platform}/qjsx "$out/"
		cp ./bin/${platform}/qnode "$out/"
		cp ./bin/${platform}/qjsxc "$out/"
		cp ./bin/${platform}/qx "$out/"
	`
}


const bin = {
	qjsx: () => `${binDir}/qjsx`,
	qnode: () => `${binDir}/qnode`,
	qjsxc: () => `${binDir}/qjsxc`,
	qx: () => `${binDir}/qx`,
}


export const install = () => {
	jix.alias({
		...bin
	})
}

export default bin