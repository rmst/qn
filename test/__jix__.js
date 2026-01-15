import container from "./container.js"

export const run = {
	containerized: jix.script`
		${container.run()} bash -c '
			export PATH=/build:$PATH
			export BUILD_DIR=/build
			make build
			node --test test/*.test.js test/**/*.test.js
		'
	`,

	default: jix.script`
		cd ${import.meta.dirname}/..
		make build
		node --test test/*.test.js test/**/*.test.js
	`,
}
