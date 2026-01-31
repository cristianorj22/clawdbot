---
summary: "Como atualizar seu fork com as mudanças do upstream (origin) com segurança (Windows/PowerShell)"
read_when:
  - Você está usando um fork e quer puxar atualizações do upstream sem contribuir de volta
  - Você precisa atualizar com segurança e resolver conflitos de merge
---

# Atualizar seu fork a partir do upstream (origin)

Este guia documenta um fluxo **simples e seguro** para manter seu fork atualizado com o upstream.

## Premissas

- Você tem **dois remotes**:
  - `origin`: o repositório upstream (ex: `openclaw/openclaw`)
  - `fork` (ou outro nome): o seu fork (ex: `seu-usuario/openclaw`)
- Você trabalha no branch `main`.
- Você quer **trazer updates do upstream** e depois **enviar para o seu fork**.

> Dica: confirme seus remotes e o tracking atual antes de qualquer atualização.

```powershell
git remote -v
git branch -vv
```

## Fluxo recomendado (PowerShell)

### 0) Verifique se o working tree está limpo

```powershell
git status
```

Se aparecerem arquivos modificados e você não quer incluí-los agora, **commite** ou **desfaça** antes de atualizar.

### 1) Buscar atualizações do upstream

```powershell
git fetch origin
```

Opcional (ver o que vai entrar):

```powershell
git log --oneline --decorate HEAD..origin/main
```

### 2) Trazer as mudanças do upstream para seu `main`

```powershell
git merge origin/main
```

Se o merge concluiu sem conflitos, siga para “3) Enviar para o seu fork”.

### 3) Enviar para o seu fork

Se o seu `main` já estiver trackeando o branch remoto do seu fork, basta:

```powershell
git push
```

Se você preferir ser explícito (ou não tiver tracking configurado), use:

```powershell
git push fork main
```

## Como resolver conflitos (quando acontecer)

Se o `git merge origin/main` parar com conflitos:

1) Veja os arquivos em conflito:

```powershell
git status
```

2) Abra os arquivos, resolva os marcadores (`<<<<<<<`, `=======`, `>>>>>>>`).

3) Marque como resolvido:

```powershell
git add -A
```

4) Conclua o merge:

```powershell
git commit
```

5) Envie para seu fork:

```powershell
git push
```

## Problema comum: “untracked files would be overwritten by merge”

Isso acontece quando existem arquivos **não rastreados** no seu checkout que o merge precisaria escrever.

### Passo 1: ver o que seria apagado

```powershell
git clean -nd
```

### Passo 2: apagar os untracked (se for seguro)

```powershell
git clean -fd
```

Depois disso, rode o merge novamente:

```powershell
git merge origin/main
```

## Problema comum (Windows): hook `pre-commit` falha e impede o `git commit`

Este repo roda um hook que formata arquivos staged via:
- `git-hooks/pre-commit` → `node scripts/format-staged.js`

Se o commit falhar por hook:

1) Rode o hook manualmente para ver o erro:

```powershell
node scripts/format-staged.js
```

2) Garanta dependências instaladas:

```powershell
pnpm install
```

3) Tente o commit novamente:

```powershell
git commit
```

## “Quero voltar atrás” (abortando um merge em andamento)

Se você iniciou um merge e quer abortar antes de concluir:

```powershell
git merge --abort
```

Se você já concluiu o merge e quer desfazer commits locais, use com cuidado:

```powershell
git reset --hard HEAD~1
```

> Atenção: `reset --hard` descarta mudanças locais. Use só quando tiver certeza.

