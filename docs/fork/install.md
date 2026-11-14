# effortless フォーク版 本番導入手順書（1週間の試用）

GigiTiti-Kai/effortless の main（effort 自動切替 2a）を、普段使いの Claude Code（`/home/hadas/.claude`）に入れて1週間試すための手順。止め方と元に戻す方法は [rollback.md](rollback.md) にある。

## まず覚えること

1. README の `HeyCubit/effortless` のコマンドは使わない。上流版が入り、このフォークの変更（2a）は入らない
2. 入れる前に `settings.json` などをバックアップする（下の「1. バックアップ」）
3. 試用中に「Update」のカードが出ても押さない。「Later」か ✕ で閉じる（上流の新版を知らせるカードのため）
4. `/effort` で effort を自分で変えると、Auto が切れ、新しいチャットでも切れたままになる。戻すときは `/effortless auto`

初回は「1. バックアップ」から「4. 入ったことを確かめる」までを順に通して読む。5章以降は必要になったときに開く。

## 何が入るか

| 項目 | 内容 |
| --- | --- |
| 入れ元 | フォークの marketplace ファイル `docs/fork/marketplace.json`（main 上）。中身は `https://github.com/GigiTiti-Kai/effortless.git` の `main` を指す |
| 入る commit | インストールした時点の main の先頭。`installed_plugins.json` の `gitCommitSha` に記録される |
| marketplace 名 | `effortless-fork`（上流の `effortless` と名前がぶつからない） |
| plugin ID | `effortless@effortless-fork` |
| スコープ | user（すべてのチャットで動く。work board のエージェントのセッションも含む） |
| 版数 | 1.72.0（上流と同じ番号） |

版数が上流と同じなので、`claude plugin update` ではフォークの main が進んでも更新されない（「already at the latest version」と出て何もしない）。新しい commit に入れ替えるときは、アンインストールしてから入れ直す（rollback.md の「入れ直す」）。

## 0. 入れる前に確かめること

1. Claude Code の版を見る

   ```bash
   claude --version
   ```

   2.1.325 で確かめた。これより新しい版では動きが変わっている場合がある。

2. main に今回の修正が入っているか見る（PR がマージ済みか）

   ```bash
   git ls-remote https://github.com/GigiTiti-Kai/effortless.git refs/heads/main
   ```

   出てきた SHA を控える。4章で、入ったものと同じかを照らし合わせる。

3. 普段の effort を決めておく。相づち（「ok」「はい」「続けて」）は、判定役を呼ばずにセッションの effort で送られる。いまの `settings.json` は `effortLevel` が `high`、`modelSettings` で Opus 5.5 が `medium`、Fable 5.2 が `xhigh` になっている

## 1. バックアップ

インストールで書き換わるのは `settings.json`、`plugins/installed_plugins.json`、`plugins/known_marketplaces.json` の3つ（隔離した環境で、インストール前後のファイル一覧を比べて確かめた）。この3つと、念のため `/home/hadas/.claude.json` を写す。

```bash
B=/home/hadas/.claude/effortless-trial-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$B"
cp -p /home/hadas/.claude/settings.json /home/hadas/.claude/plugins/installed_plugins.json /home/hadas/.claude/plugins/known_marketplaces.json /home/hadas/.claude.json "$B"/
ls -la "$B"
echo "$B"
```

最後に出たフォルダのパスを控える。戻すときに使う。

- `/home/hadas/.claude.json` はチャットのたびに書き換わる。戻すときにこれを上書きすると、試用中の他の記録まで巻き戻るので、普段は戻さない（rollback.md 参照）
- `/home/hadas/.claude` は git で管理されているが、`.gitignore` が `*` で始まるため `settings.json` は追跡されていない。git の履歴はバックアップの代わりにならない

## 2. インストール

ターミナルで次の2行を順に打つ。

```bash
claude plugin marketplace add https://raw.githubusercontent.com/GigiTiti-Kai/effortless/main/docs/fork/marketplace.json
```

```bash
claude plugin install effortless@effortless-fork
```

成功すると次のように出る。

```text
✔ Successfully added marketplace: effortless-fork (declared in user settings)
✔ Successfully installed plugin: effortless@effortless-fork (scope: user)
16 userConfig options not yet set — run /plugin configure effortless@effortless-fork in Claude Code, or pass --config KEY=VALUE.
```

最後の行は気にしなくてよい。設定していない項目には plugin.json の既定値が入る。安いモデルへの振り分け（`modelAuto`）も既定で off（テスト `the cheaper model is off by default…` で固定している）。

- PR をマージした直後は、raw.githubusercontent.com の古い写しが数分返ることがある。marketplace の追加でエラーが出たら、5分ほど待ってからもう一度打つ
- `--config` は付けない。既定値のままで試す前提でこの手順書を書いている

## 3. 記録を有効にする（任意）

判定役（Haiku）がどう判断したかの記録は、環境変数 `EFFORTLESS_LOG` を指定したときだけ書かれる。`/home/hadas/.claude/settings.json` の `env` に1行足す。

```json
"EFFORTLESS_LOG": "/home/hadas/.claude/effortless-proof.log"
```

この記録には制限がある。

- 1つのチャットの最新200行だけが残る。書くたびにファイル全体を上書きする作りのため
- 同時に開いている複数のチャットは、同じファイルを上書きし合う

このため、1週間の集計には使わない。集計は5章のとおりトランスクリプトから出す。この記録は、気になる場面の直後に開いて、判定役の判断を確かめる用途に使う。

## 4. 入ったことを確かめる

1. 新しいチャットを開く（すでに開いているチャットでは `/reload-plugins`）
2. プロンプトの上に `effortless setup 1/4` が出る。`Just Haiku (no key)` を選ぶ（Skip でもよい。判定役の既定は Haiku）
3. 入った commit を確かめる

   ```bash
   grep -A8 '"effortless@effortless-fork"' /home/hadas/.claude/plugins/installed_plugins.json | grep gitCommitSha
   ```

   0章で控えた SHA と同じなら合っている。

4. 今回の修正が入っているか確かめる

   ```bash
   grep -c "e.tool === 'Skill'" /home/hadas/.claude/plugins/cache/effortless-fork/effortless/1.72.0/hooks/register.tsx
   ```

   `1` が出れば入っている。`0` なら修正の前の main が入っているので、rollback.md の「入れ直す」でやり直す。

5. チャットで `/effortless debug` を打つ。出力に `model: always the chat's` があれば、安いモデルへの振り分けは off

`/effortless` が「mod が読み込まれていない」と答えたときだけ、`settings.json` の `env` に `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` を足して Claude Code を起動し直す。2.1.325 では、この設定なしで読み込まれることを確かめた。

## 5. 1週間で記録すること

### 自動で残るもの

| 記録 | 場所 | 形式 |
| --- | --- | --- |
| 送った effort とトークン数（正本） | `/home/hadas/.claude/projects/<プロジェクト>/<チャットID>.jsonl` | `api-request` 行の `params.output_config.effort`、`assistant` 行の `message.usage` |
| subagent の分 | 同じフォルダの `<チャットID>/subagents/*.jsonl` | 同上 |
| 判定役の判断（任意、3章） | `/home/hadas/.claude/effortless-proof.log` | 1行1件。`judged by haiku in 985 ms: …`、`request 0 (…): effort low -> high sent`、`response 1 at high: …` |
| 帯の描画の記録 | `/home/hadas/.claude/effortless-render-<チャットID先頭8文字>.log` | チャットごとに1ファイル。effort の集計には使わない |

トランスクリプトは effortless を入れる前の分も残っているので、入れる前の1週間と比べられる。

### 集計のしかた

フォークに集計用のスクリプト `tools/effort-trial.py` がある。インストールしたコピーにも入っている。

```bash
python3 /home/hadas/.claude/plugins/cache/effortless-fork/effortless/1.72.0/tools/effort-trial.py --since 2026-11-16 --until 2026-11-22
```

日付は UTC で、試用した週に合わせて変える。比べるために、入れる前の週でも同じように回す。

```bash
python3 /home/hadas/.claude/plugins/cache/effortless-fork/effortless/1.72.0/tools/effort-trial.py --since 2026-11-09 --until 2026-11-15
```

出力の例（隔離した環境での試験の分）:

```text
prompts a person typed: 14 between turns, 3 while a turn ran
turns of 2+ requests: 11, of them sent at more than one effort: 7

who       model                effort  requests      output  cache read  cache write    weighted
main      claude-fable-5-2     high          17        4248      875889        44681      164728
main      claude-fable-5-2     low           27        4458     1535993        54810      244474
...
weighted cost in all: 553722, per typed prompt: 27686
```

`weighted` は、入力1トークンを1として、キャッシュ書き込み1.25、キャッシュ読み込み0.1、出力5で重みを付けた値（effortless 自身の計算と同じ重み）。金額ではない。

### 見る指標

| 指標 | どこを見るか | 見方 |
| --- | --- | --- |
| 打った入力あたりの重み付きコスト | `per typed prompt` | 入れる前の週より下がっているか |
| 送った effort の分布 | `main` 行の effort ごとの `requests` | low・medium が増え、xhigh・max が減っているか |
| 途中で effort が変わったターン | `sent at more than one effort` | 多いほど、選んだ effort がターンの途中で効かなくなっている（途中入力、Skill の読み込みのあと） |
| ターン中の入力 | `while a turn ran` | 途中入力の多さ。上の指標の原因を見分けるのに使う |
| subagent の effort | `subagent` 行 | effortless は既定で subagent を書き換えない。入れる前と同じ分布のはず |

### 手で残すもの

数字に出ないのは、低い effort で答えの質が落ちたかどうか。「low で返ってきた答えが浅くてやり直した」と感じたら、日付・チャット・打った文を1行ずつメモする。置き場所の例: `/home/hadas/.claude/effortless-trial-notes.md`。

## 6. 試用中に起きること

### effort の決まり方

| 入力 | 送られる effort |
| --- | --- |
| 「Use high effort」「max effort」のように水準を名指し | その水準（判定役は呼ばない） |
| 「ok」「はい」「続けて」などの相づち | セッションの effort（判定役は呼ばない） |
| 「ありがとう」だけ | low |
| それ以外 | Haiku が決めた水準（約1秒待つ） |

書き換えるのはターンの最初のリクエストだけ。2回目以降のリクエストは、最初の値をアプリが引き継ぐ。ただし次の場合、アプリはそのターンの残りをセッションの effort で送る。effortless は送り直さず、送られた値を表示と記録に出す。

- ターンの途中で文を打った
- ターンの途中で Skill（スキル）が読み込まれた。普段の作業ではスキルの読み込みが多いので、この場合が多いと見込まれる

### 知っておくこと

| 場面 | 起きること |
| --- | --- |
| Update のカードが出た | 上流 HeyCubit の新しい版の知らせ。押しても `claude plugin update` が「already at the latest version」で終わるので中身は変わらない（CLI で確かめた）。カードには「Installed. Open a new chat…」と出る見込み（コードから読んだ動きで、カードは試していない）。押さずに閉じる |
| `/effort` で自分で変えた | Auto が切れ、以後のチャットでも切れたまま。`/effortless auto` で戻す |
| subagent の effort | 既定（Helpers off）では書き換えない。アプリの値のまま |
| subagent の完了の知らせで始まるターン | 直前に選んだ effort で送られる（入力が無いので判定役は呼ばない） |
| work board のエージェント | user スコープに入れると、エージェントのチャットでも effortless が動き、最初のリクエストの effort を書き換える |

## 7. 既知の問題（導入の妨げになるか）

| 問題 | 妨げになるか | 根拠 |
| --- | --- | --- |
| `claude plugin validate .` が `effortless.updateCheck is not declared` で失敗する | ならない。インストールも読み込みも通る | 上流 `88296b5` からある。隔離した環境で、インストール・チャットの起動・記録の書き込みまで通った |
| `claude plugin test .` で61件が落ちる（290件中） | ならない。落ちるのは描画のテストや textless など、effort の判断と関係しないもの | 変更前（e5c590d）から同じ名前のテストが落ちている。chess の「2秒以内」は時間で通ったり落ちたりする |
| `tsc` で型エラーが出る（hooks 84件、tests 112件） | ならない。動作には関係しない | hooks の84件は変更前と同じ。2.1.325 の型定義との差 |

## 問い合わせ先

| 困りごと | 見るところ |
| --- | --- |
| 止めたい、戻したい | [rollback.md](rollback.md) |
| effort の判断がおかしい | `/effortless debug` の出力と、3章の記録 |
| この手順書の確認結果 | タスク EFR-2 の報告 |

最終更新日: 2026-11-14
