export const run = {
	default: jix.script`

	`,
}




const binDir = () => {

	let repo = jix.git.checkout({
		repo: import.meta.dirname,
		commit: jix.exec`git rev-parse HEAD`
	})

	let repo = import.meta.dirname

	let platform = jix.target().host.os === "macos" ? "darwin" : "linux"

	return jix.build`
		cp -r "${repo}" ./repo
		cd repo
		make build
		mkdir -p "$out"
		cp ./bin/${platform}/qjsx "$out/"
		cp ./bin/${platform}/qjsx-node "$out/"
		cp ./bin/${platform}/qjsxc "$out/"
	`
}


const bin = {
	qjsx: () => `${binDir}/qjsx`,
	"qjsx-node": () => `${binDir}/qjsx-node`,
	qjsxc: () => `${binDir}/qjsxc`,
	qx: () => `${binDir}/qx`,
}


export const install = () => {
	jix.alias({
		...bin
	})
}

export default bin