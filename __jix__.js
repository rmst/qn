
export const run = {
	// default: () => jix.script`
	// `,

	bench: () => jix.script`
		cd ${import.meta.dirname}
		make build
		NODE_PATH=./qx:./node ./bin/qx bench/startup.js
	`,
}


const binDir = () => {

	let repo = jix.importDir(import.meta.dirname, {
		respectGitignore: true,
	})

	// let repo = import.meta.dirname

	let platform = jix.target().host.os === "macos" ? "darwin" : "linux"

	return jix.build`
		cp -R "${repo}" ./repo
		cd repo
		make build GIT_DIRTY=1
		mkdir -p "$out"
		cp ./bin/${platform}/qjsx "$out/"
		cp ./bin/${platform}/qn "$out/"
		cp ./bin/${platform}/qnc "$out/"
		cp ./bin/${platform}/qx "$out/"
	`
}


const bin = {
	qjsx: () => `${binDir}/qjsx`,
	qn: () => `${binDir}/qn`,
	qnc: () => `${binDir}/qnc`,
	qx: () => `${binDir}/qx`,
}


export const install = () => {
	jix.alias({
		...bin
	})
}

export default bin