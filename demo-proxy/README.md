# デモ用の中継サーバー

公開デモ（`?demo=1` で開いたとき）のためだけの Cloudflare Worker です。
ブラウザからのAIの呼び出しを受け取り、こちらのOpenAIキーを付けて中継します。キーはブラウザには渡しません。

自分で動かす場合は、アプリ単体で使えるので、この中継サーバーは必要ありません。

## 置き方

```bash
cd demo-proxy
npx wrangler login                      # ブラウザでCloudflareにログイン（初回だけ）
npx wrangler kv namespace create DEMO_LIMITS   # 出てきた id を wrangler.toml に書く
npx wrangler secret put OPENAI_API_KEY  # OpenAIのキーを登録する
npx wrangler deploy
```

## 入れてある制限

| 項目 | 内容 |
|---|---|
| 呼び出せるページ | デモページ（GitHub Pages）と、手元の確認用のアドレスだけ |
| 中継する呼び出し | チャット、読み上げ、文字起こしの3つだけ |
| 使えるモデル | gpt-4.1 / gpt-5.4 / gpt-4o-mini-tts / gpt-4o-mini-transcribe |
| 1日の回数 | ひとり40回まで、全体で600回まで |
| 1回の大きさ | 300KBまで。返す長さにも上限あり |

上限に達すると、アプリには「本日の上限に達しました」と返します。
