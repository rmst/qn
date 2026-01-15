

export let run = () => {

	let image = jix.container.imageFromDockerfile`
		FROM docker.io/nixos/nix@\
		sha256:04abdb9c74e0bd20913ca84e4704419af31e49e901cd57253ed8f9762def28fd

		RUN nix-env -iA nixpkgs.gcc
		RUN nix-env -iA nixpkgs.gnumake
		RUN nix-env -iA nixpkgs.gnupatch
		RUN nix-env -iA nixpkgs.nodejs_22
		RUN nix-env -iA nixpkgs.coreutils nixpkgs.findutils nixpkgs.gnugrep nixpkgs.gnused nixpkgs.gnutar nixpkgs.gzip nixpkgs.gawk

	`
	
	let qjsxRoot = `${import.meta.dirname}/..`

	return jix.container.run({image, workdir: "/wd", volumes: {wd: qjsxRoot}})
}

export default { run }
