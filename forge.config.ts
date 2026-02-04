import crypto from 'crypto';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type {
  HookFunction,
  HookFunctionErrorCallback,
  TargetArch,
  TargetPlatform,
} from '@electron/packager';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import MakerAppImage from '@pengx17/electron-forge-maker-appimage';
import setLanguages from 'electron-packager-languages';
import * as fs from 'fs';
import * as path from 'path';
import { stringify as yamlStringify } from 'yaml';

const nativeModules = ['better-sqlite3', 'keytar', 'bindings', 'file-uri-to-path'];
const ResolvedMakerAppImage = MakerAppImage;
const keepLanguages = new Set(['en', 'en-US', 'zh-CN', 'ru']);

const isStartCommand = process.argv.some((arg) => arg.includes('start'));

const artifactRegex = /.*\.(?:exe|dmg|AppImage|zip|deb|rpm)$/;
const platformNamesMap: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};
const ymlMapsMap: Record<string, string> = {
  darwin: 'latest-mac.yml',
  linux: 'latest-linux.yml',
  win32: 'latest.yml',
};
const ignorePatterns = [
  /^\/\.git/,
  /^\/\.github/,
  /^\/\.vscode/,
  /^\/\.idea/,
  /^\/openspec/,
  /^\/docs?/,
  /^\/scripts?/,
  /^\/tests?/,
  /^\/mocks?/,
  /^\/src/,
  /^\/node_modules\/\.cache/,
];
const setLanguagesHook = setLanguages([...keepLanguages.values()]);
const packagerAfterCopy: HookFunction[] = [
  (
    buildPath: string,
    electronVersion: string,
    platform: TargetPlatform,
    arch: TargetArch,
    callback: HookFunctionErrorCallback,
  ) => {
    if (platform !== 'win32') {
      callback();
      return;
    }

    setLanguagesHook(buildPath, electronVersion, platform, arch, callback);
  },
];

function normalizeArtifactName(value?: string) {
  if (!value) {
    return 'app';
  }

  return value.trim().replace(/\s+/g, '-');
}

function isSquirrelArtifact(artifactPath: string) {
  const fileName = path.basename(artifactPath);
  if (fileName === 'RELEASES') {
    return true;
  }

  return artifactPath.endsWith('.nupkg');
}

const appImageMaker = new ResolvedMakerAppImage({
  config: {
    icons: [
      {
        file: 'images/32x32.png',
        size: 32,
      },
      {
        file: 'images/64x64.png',
        size: 64,
      },
      {
        file: 'images/128x128.png',
        size: 128,
      },
      {
        file: 'images/128x128@2x.png',
        size: 256,
      },
    ],
  },
});
appImageMaker.name = '@pengx17/electron-forge-maker-appimage';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/{better-sqlite3,keytar}/**/*',
    },
    name: 'Antigravity Manager',
    executableName: 'antigravity-manager',
    icon: 'images/icon', // Electron Forge automatically adds .icns/.ico
    extraResource: ['src/assets'], // Copy assets folder to resources/assets
    afterCopy: packagerAfterCopy,
    ignore: ignorePatterns,
    prune: true,
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // Copy native modules to the packaged app
      const nodeModulesPath = path.join(buildPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }

      const copyModuleRecursive = (moduleName: string) => {
        const srcPath = path.join(process.cwd(), 'node_modules', moduleName);
        const destPath = path.join(nodeModulesPath, moduleName);

        if (fs.existsSync(srcPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true });
          console.log(`Copied native module: ${moduleName}`);
        } else {
          console.warn(`Native module not found: ${moduleName}`);
        }
      };

      for (const moduleName of nativeModules) {
        copyModuleRecursive(moduleName);
      }

      // Copy assets to resources folder
      const assetsSrc = path.join(process.cwd(), 'src', 'assets');
      const assetsDest = path.join(buildPath, 'resources', 'assets');

      if (fs.existsSync(assetsSrc)) {
        if (!fs.existsSync(assetsDest)) {
          fs.mkdirSync(assetsDest, { recursive: true });
        }
        fs.cpSync(assetsSrc, assetsDest, { recursive: true });
        console.log(`Copied assets from ${assetsSrc} to ${assetsDest}`);
      } else {
        console.warn(`Assets directory not found: ${assetsSrc}`);
      }
    },
    postMake: async (_config, makeResults) => {
      if (!makeResults?.length) {
        return makeResults;
      }

      const ymlByPlatform = new Map<
        string,
        {
          basePath: string;
          yml: {
            version?: string;
            files: {
              url: string;
              sha512: string;
              size: number;
            }[];
            releaseDate?: string;
          };
        }
      >();

      makeResults = makeResults.map((result) => {
        const productName = normalizeArtifactName(result.packageJSON.productName);
        const platformName = platformNamesMap[result.platform] || result.platform;
        const version = result.packageJSON.version;
        const platformKey = result.platform;

        if (!ymlByPlatform.has(platformKey)) {
          ymlByPlatform.set(platformKey, {
            basePath: '',
            yml: {
              version,
              files: [],
            },
          });
        }

        const platformState = ymlByPlatform.get(platformKey)!;

        result.artifacts = result.artifacts
          .map((artifact) => {
            if (!artifact) {
              return null;
            }

            if (isSquirrelArtifact(artifact)) {
              return artifact;
            }

            if (!artifactRegex.test(artifact)) {
              return artifact;
            }

            if (!platformState.basePath) {
              platformState.basePath = path.dirname(artifact);
            }

            const newArtifact = `${path.dirname(artifact)}/${productName}-${version}-${platformName}-${result.arch}${path.extname(artifact)}`;
            if (newArtifact !== artifact) {
              fs.renameSync(artifact, newArtifact);
            }

            try {
              const fileData = fs.readFileSync(newArtifact);
              const hash = crypto.createHash('sha512').update(fileData).digest('base64');
              const { size } = fs.statSync(newArtifact);

              platformState.yml.files.push({
                url: path.basename(newArtifact),
                sha512: hash,
                size,
              });
            } catch {
              console.error(`Failed to hash ${newArtifact}`);
            }

            return newArtifact;
          })
          .filter((artifact) => artifact !== null);

        return result;
      });

      const releaseDate = new Date().toISOString();
      for (const [platform, platformState] of ymlByPlatform.entries()) {
        const ymlFileName = ymlMapsMap[platform];
        if (!ymlFileName || !platformState.basePath) {
          continue;
        }

        platformState.yml.releaseDate = releaseDate;
        const ymlPath = path.join(platformState.basePath, ymlFileName);
        fs.writeFileSync(ymlPath, yamlStringify(platformState.yml));

        const sampleResult = makeResults.find((result) => result.platform === platform);
        if (!sampleResult) {
          continue;
        }

        makeResults.push({
          artifacts: [ymlPath],
          platform: sampleResult.platform,
          arch: sampleResult.arch,
          packageJSON: sampleResult.packageJSON,
        });
      }

      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: 'images/icon.ico',
      iconUrl:
        'https://raw.githubusercontent.com/Draculabo/AntigravityManager/main/images/icon.ico',
    }),
    new MakerDMG(
      {
        overwrite: true,
        icon: 'images/icon.icns',
        iconSize: 160,
      },
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin']),
    appImageMaker,
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers: [
    {
      /*
       * Publish release on GitHub as draft.
       * Remember to manually publish it on GitHub website after verifying everything is correct.
       */
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'Draculabo',
          name: 'AntigravityManager',
        },
        draft: true,
        prerelease: false,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    ...(!isStartCommand
      ? [
          new AutoUnpackNativesPlugin({}),
          new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
          }),
        ]
      : []),
  ],
};

export default config;
