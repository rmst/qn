export const run = {
	default: jix.script`

	`,
}

const binDir = () => {
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
}


export const install = () => {
	jix.alias({
		...bin
	})
}


export default bin