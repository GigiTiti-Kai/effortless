# effortless フォーク版 止め方・戻し手順書

[install.md](install.md) で入れた `effortless@effortless-fork` を、一時的に止める・外す・元の設定に戻すための手順。

## まず覚えること

1. 少しのあいだ止めるだけなら、チャットで `/effortless auto`（もう一度打つと戻る）
2. 外すときは、アンインストールと marketplace の削除の2行を打つ
3. バックアップからの復元は、2行で外したあとも `settings.json` がおかしいときだけ行う

どの節も単独で読めるように書いている。必要な節だけ開く。

## 一時停止（入れたまま effort を書き換えさせない）

チャットで次を打つ。

```text
/effortless auto
```

`Auto off: the effort is yours.` と出れば止まっている。

- アプリの effort（`/effort` や起動時の `--effort`）がそのまま送られる
- この切り替えは、これから開くチャットにも引き継がれる
- 判定役（Haiku）も呼ばれなくなる
- 戻すときは、もう一度 `/effortless auto` を打つ（`Auto on: …` と出る）

effortless の表示ごと消したいときは、plugin を無効にする。

```bash
claude plugin disable effortless@effortless-fork --scope user
```

戻すときは `claude plugin enable effortless@effortless-fork --scope user`。どちらも、新しく開いたチャットから効く。

## アンインストール

```bash
claude plugin uninstall effortless@effortless-fork
```

```bash
claude plugin marketplace remove effortless-fork
```

成功すると次のように出る。

```text
✔ Successfully uninstalled plugin: effortless (scope: user)
✔ Successfully removed marketplace: effortless-fork
```

この2行で `settings.json` から次の3つが消える（隔離した環境で確かめた）。

- `enabledPlugins` の `effortless@effortless-fork`
- `extraKnownMarketplaces` の `effortless-fork`
- `pluginConfigs` の `effortless@effortless-fork`（設定を保存していた場合）

開いているチャットでは、閉じるまで effortless が動き続ける。外したあとは新しいチャットを開く。

### 外したあとに残るファイル

アンインストールでは消えない。残っていても動作には関係しないが、きれいにしたいときは中身を見てから消す。

| ファイル | 中身 |
| --- | --- |
| `/home/hadas/.claude/plugins/store/effortless_effortless-fork-*.json` | Auto の on/off、最後の pick、セットアップ済みかどうか。入れ直したときに引き継がれる |
| `/home/hadas/.claude/plugins/data/effortless-release-check/` | 上流の新版を調べるための小さな git フォルダ |
| `/home/hadas/.claude/plugins/cache/effortless-fork/` | インストールしたコピー（Claude Code が後で片付けることがある） |
| `/home/hadas/.claude/effortless-render-*.log` | チャットごとの描画の記録 |
| `/home/hadas/.claude/effortless-proof.log` | install.md 3章の記録（有効にした場合） |
| `/home/hadas/.config/jev/.env` | セットアップや Judge のカードで Jev のキーを貼った場合だけ。キーが平文で入っている |

消す前に一覧を見る。

```bash
ls -d /home/hadas/.claude/plugins/store/effortless_effortless-fork-*.json /home/hadas/.claude/plugins/data/effortless-release-check /home/hadas/.claude/plugins/cache/effortless-fork /home/hadas/.claude/effortless-render-*.log /home/hadas/.claude/effortless-proof.log 2>/dev/null
```

install.md 3章で `settings.json` の `env` に足した `EFFORTLESS_LOG` は、アンインストールでは消えない。手で消す。

## バックアップからの復元

アンインストールのあとも `settings.json` が戻っていないときに使う。試用中に自分で変えた設定（他の plugin、権限、hook など）も、バックアップの時点に戻る点に注意する。

1. バックアップのフォルダを探す

   ```bash
   ls -d /home/hadas/.claude/effortless-trial-backup-*
   ```

2. いまの `settings.json` とバックアップの差を見る（`B=` には1で出たパスを入れる）

   ```bash
   B=/home/hadas/.claude/effortless-trial-backup-YYYYMMDD-HHMMSS
   diff "$B"/settings.json /home/hadas/.claude/settings.json
   ```

   effortless 以外の差があれば、その行は手で残すほうが安全。

3. Claude Code のチャットをすべて閉じてから写し戻す

   ```bash
   cp -p "$B"/settings.json /home/hadas/.claude/settings.json
   cp -p "$B"/installed_plugins.json "$B"/known_marketplaces.json /home/hadas/.claude/plugins/
   ```

4. 新しいチャットを開き、`claude plugin list` に `effortless@effortless-fork` が無いことを確かめる

`/home/hadas/.claude.json` も同じフォルダにあるが、普段は写し戻さない。チャットの履歴や各プロジェクトの設定が、バックアップの時点に巻き戻るため。

## 入れ直す（別の commit に替える）

`claude plugin update` は版数（1.72.0）しか見ないので、フォークの main が進んでも入れ替わらない。新しい commit に替えるときは、外してから入れる。

```bash
claude plugin uninstall effortless@effortless-fork
```

```bash
claude plugin marketplace update effortless-fork
```

```bash
claude plugin install effortless@effortless-fork
```

入ったら install.md の「4. 入ったことを確かめる」の3と4を行う。セットアップと Auto の on/off は store に残っているので、引き継がれる。

## 問い合わせ先

| 困りごと | 見るところ |
| --- | --- |
| 入れ方 | [install.md](install.md) |
| 外したのに effort が書き換わる | 開きっぱなしのチャットが残っていないか。`claude plugin list` の表示 |

最終更新日: 2026-11-14
