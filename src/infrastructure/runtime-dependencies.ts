import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// External JS keeps resolving native/runtime packages from the installed base.
export function useInstalledDependencies(baseRoot: string) {
  const parentURL = pathToFileURL(path.join(baseRoot, 'package.json')).href;
  const installedRequire = createRequire(parentURL);
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':'))
          throw error;
        if (context.conditions.includes('require'))
          return {
            url: pathToFileURL(installedRequire.resolve(specifier)).href,
            shortCircuit: true,
          };
        return next(specifier, { ...context, parentURL });
      }
    },
  });
}
