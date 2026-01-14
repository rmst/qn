let nixImage = () => jix.container.imageFromDockerfile`
	FROM docker.io/nixos/nix@\
	sha256:04abdb9c74e0bd20913ca84e4704419af31e49e901cd57253ed8f9762def28fd

	RUN nix-env -iA nixpkgs.gcc
	RUN nix-env -iA nixpkgs.gnumake
	RUN nix-env -iA nixpkgs.gnupatch
	RUN nix-env -iA nixpkgs.nodejs_22
`

let dockerVolumes = () => ({
	build: jix.container.volume("qjsx-test.build"),
	"/nix": jix.container.volume("qjsx-test.nix"),
	"/root/.jix": jix.container.volume("qjsx-test.jix"),
})

export let testContainer = ({volumes={}, env={}}={}) => {
	let qjsxRoot = `"$(realpath "${import.meta.dirname}/..")"`

	volumes = {
		...volumes,
		wd: qjsxRoot,
		...dockerVolumes(),
	}

	return jix.container.run({workdir: "/wd", volumes, env})
}

export let testImage = nixImage

export default {
	testContainer,
	testImage,
	install: () => {
		dockerVolumes()
	},
}
