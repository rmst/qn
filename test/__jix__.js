import container from "./container.js"

export const run = {
	containerized: jix.script`
		cd ${import.meta.dirname}/..
		${container.run()} bash -c '
			node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
		'
	`,

	default: jix.script`
		cd ${import.meta.dirname}/..
		node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
	`,
}
