# Changelog

## 0.2.2

- Add ESM output and keep CommonJS output with matching type declarations.
- Enable strict compiler and type-aware lint checks.
- Check installed npm packages on supported Node versions, Bun, and browser engines.
- Validate Multicall responses before using their values.
- Route time results to the correct interval group.
- Wait for manual updates to complete their reads.
- Replace publishing on development pushes with the `main` to `release` PR flow.
- Use npm trusted publishing from the release environment.
