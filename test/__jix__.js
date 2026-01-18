
let PROJECT_ROOT = `${import.meta.dirname}/..`

let image = () => jix.container.imageFromDockerfile`
	FROM docker.io/nixos/nix@\
	sha256:04abdb9c74e0bd20913ca84e4704419af31e49e901cd57253ed8f9762def28fd

	RUN nix-env -iA nixpkgs.gcc
	RUN nix-env -iA nixpkgs.gnumake
	RUN nix-env -iA nixpkgs.gnupatch
	RUN nix-env -iA nixpkgs.nodejs_22
	RUN nix-env -iA nixpkgs.coreutils nixpkgs.findutils nixpkgs.gnugrep nixpkgs.gnused nixpkgs.gnutar nixpkgs.gzip nixpkgs.gawk
	RUN nix-env -iA nixpkgs.curl

	`

let containerRun = () => jix.container.run({image, workdir: "/wd", volumes: {wd: PROJECT_ROOT}})

export const run = {
	containerized: jix.script`
		${containerRun} bash -c '
			make build
			node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
		'
	`,

	default: jix.script`
		cd ${import.meta.dirname}/..
		make build
		node --test --experimental-test-isolation=none test/*.test.js test/**/*.test.js
	`,
}
