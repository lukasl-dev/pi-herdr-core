{ lib, runCommand }:

let
  manifest = builtins.fromJSON (builtins.readFile ./package.json);
in
runCommand "pi-herdr-core-${manifest.version}"
  {
    meta = {
      inherit (manifest) description;
      license = lib.licenses.mit;
      platforms = lib.platforms.unix;
    };
  }
  ''
    mkdir -p "$out"
    cp -r ${./src} "$out/src"
    cp ${./package.json} "$out/package.json"
    cp ${./LICENSE} "$out/LICENSE"
  ''
