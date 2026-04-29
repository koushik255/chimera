 {
    description = "Frontend dev shell with Codex CLI";

    inputs = {
      nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
      flake-utils.url = "github:numtide/flake-utils";
    };

    outputs = { self, nixpkgs, flake-utils }:
      flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_20
            ripgrep
            git
          ];

          shellHook = ''
            export NPM_CONFIG_CACHE="$PWD/.npm-cache"
            export PATH="$PWD/node_modules/.bin:$PWD/frontend/node_modules/.bin:$PATH"
            mkdir -p "$NPM_CONFIG_CACHE"
            echo "Dev shell ready."
            echo "Install frontend deps with: cd frontend && npm ci"
          '';
        };
      });
  }
