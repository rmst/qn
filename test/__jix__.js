import container from "./container.js"

export const run = {
	default: jix.script`
		${container.testContainer()} ${container.testImage} bash -c '
			export PATH=~/.jix/bin:$PATH
			export BUILD_DIR=/build
			make build
			node --test test/*.test.js
		'
	`,

	host: jix.script`
		cd ${import.meta.dirname}/..
		make build
		node --test test/*.test.js
	`,
}

export const install = {
	dev: () => {
		container.install()
	}
}
