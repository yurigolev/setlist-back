import { ESLint } from 'eslint';
import { getFileInfo } from 'prettier';

export default async (files) => {
  const eslint = new ESLint();
  const codeFiles = [];
  const formatFiles = [];

  for (const file of files) {
    const info = await getFileInfo(file, { ignorePath: '.prettierignore' });
    if (info.ignored || !info.inferredParser) continue;
    formatFiles.push(file);
    if (/\.(?:[cm]?[jt]s|jsx|tsx)$/.test(file) && !(await eslint.isPathIgnored(file))) {
      codeFiles.push(file);
    }
  }

  const quoteFiles = (paths) => paths.map((file) => JSON.stringify(file)).join(' ');
  return [
    ...(codeFiles.length ? [`eslint --fix --max-warnings 0 ${quoteFiles(codeFiles)}`] : []),
    ...(formatFiles.length ? [`prettier --write ${quoteFiles(formatFiles)}`] : []),
  ];
};
