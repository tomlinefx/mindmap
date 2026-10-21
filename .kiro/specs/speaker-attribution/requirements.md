# Requirements Document

## Project Description (Input)
**誰が困っているか**: 会議の主催者。いつ・誰が・どんな発言をしたかを整理する方法がない。内容を共有するために議事録として要約しているが、発言の流れを階層で見せにくく、わかりにくい。この流れへの対策として、今のベースのソフト（会議中に発言からマップを組み立てる）を入れた。

**今どうなっているか**: マップは組み立てられるが、話している人の名前が分からない。どのノードが誰の発言で、どの決定が誰のものかを、マップからも書き出し（map.md など）からも読み取れない。

**何が変わってほしいか**: マップと書き出しで、各発言・各決定が誰のものかを表示したい。

## Introduction

会議の主催者が、マップ・字幕・根拠の発言・書き出しのどこからでも「誰が言ったか・誰が決めたか」を読み取れるようにする。相手（会議アプリの音）を声で一人ずつ見分けて「相手 A・相手 B…」の話者に分け、話者に名前を付けられるようにする。名前は会議中に手で入れる・AI が名乗りから推し量る・会議の後で直す、の 3 通りで付き、表示と書き出しに反映する。

語彙は `CONTEXT.md` に従う（話者・トラック・発言・根拠・決定・案・TODO）。主語の「mindmap」は、音を取ってマップを組み立てる Windows PC 側の全体（helper・server・画面）を指す。

## Boundary Context

- **In scope**:
  - 相手のトラックの発言を、声で最大 4 人の話者に分けること
  - 話者（自分を含む）に名前を付けること（会議中の手入力・AI の推定・会議後の修正）
  - 決定に「決定を口にした人」を持たせること
  - マップのノード・字幕・根拠の発言・書き出し（map.md・map.json・map.html・map.drawnix）に話者または名前を出すこと
- **Out of scope**:
  - 会議アプリから参加者名を取り込むこと
  - 声の特徴を会議をまたいで覚え、次の会議で同じ人を自動で同じ名前にすること
  - 自分のトラック（マイク）に複数人がいる場合に分けること（自分のトラックは常に 1 人の「自分」）
  - 決定の権限者を会話の中身から判断すること
  - 案の出した人・TODO の担当者の決め方を変えること（今の規則のまま、名前が付けば名前で出す）
- **Adjacent expectations**:
  - `map-update-latency`: 話者を決めるために発言をマップへ送るのを待つ時間は、map-update-latency の目標（話し終えてからマップに出るまで 1 秒くらい）を壊さない範囲とする。待ち時間の上限そのものは map-update-latency 側で決める
  - 音声は PC の外に出さない（product.md）。話者の見分けも PC の中で行う。外に出るのは今と同じく発言の文字と、話者のラベル・名前だけ

## Requirements

### Requirement 1: 相手を声で話者に分ける
**Objective:** As a 会議の主催者, I want 相手のトラックの発言が声ごとに別の話者として分かれること, so that 相手側に何人いても誰の発言かを区別できる

#### Acceptance Criteria
1. When 相手のトラックで新しい声の人が初めて話した, the mindmap shall その人に、まだ使っていないラベルを「相手 A」「相手 B」「相手 C」「相手 D」の順で振る
2. When 同じ声の人がセッションの中で再び話した, the mindmap shall 前と同じラベルをその発言に付ける
3. When 1 つの発言の途中で相手の話者が替わった, the mindmap shall 発言を話者の替わり目で分け、分けた発言ごとに話者を 1 人だけ付ける
4. If 相手の話者が 4 人を超えた, the mindmap shall 5 人目以降の発言を、ラベルの無い「相手」として扱う
5. If 発言の話者を待ち時間の上限までに決められなかった, the mindmap shall その発言をラベルの無い「相手」として扱い、差分更新を止めない
6. The mindmap shall 自分のトラックの発言には常に話者「自分」を付ける
7. If 話者の見分けに要るもの（モデルなど）が欠けている, the mindmap shall 開始前の確かめ（`check`）でそれを知らせ、セッションは話者を分けずに（相手を「相手」1 人として）始められるようにする

### Requirement 2: 会議中に名前を付ける
**Objective:** As a 会議の主催者, I want 話者に会議中にその場で名前を付けられること, so that 「相手 A」ではなく実際の名前で誰の発言かを読める

#### Acceptance Criteria
1. When 主催者が会議中の画面で話者（自分・相手 A〜D）を選んで名前を入力した, the mindmap shall その話者に名前を付け、以後その話者を表示するすべての場所で名前を出す
2. When 主催者が CLI で話者のラベルと名前を指定した, the mindmap shall 画面から入力したときと同じくその話者に名前を付ける
3. When すでに名前のある話者に主催者が別の名前を入力した, the mindmap shall 新しい名前に置き換え、過去の発言を含めて表示を新しい名前にする
4. If 主催者がセッションにまだ現れていない話者に名前を付けようとした, the mindmap shall 名前を付けず、その話者がまだいないことを伝える
5. While 話者に名前が無い, the mindmap shall その話者をラベル（「自分」「相手 A」など）で表示する

### Requirement 3: AI が名乗りから名前を推し量る
**Objective:** As a 会議の主催者, I want 「田中です」のような名乗りから話者の名前が自動で付くこと, so that 手で入れなくても名前で読める

#### Acceptance Criteria
1. When ある話者の発言に、その話者自身の名乗りが含まれていた, the mindmap shall その話者に推定の名前を付ける
2. If 推定の根拠が、その話者自身の発言ではない（他の人がその名前を呼んだだけ、など）, the mindmap shall その推定の名前を付けない
3. While 話者に主催者が手で入れた名前がある, the mindmap shall AI の推定でその名前を置き換えない
4. When 推定の名前がすでにある話者が別の名前を名乗った, the mindmap shall 推定の名前を新しい名乗りの名前に置き換える
5. The mindmap shall 推定で付いた名前と手で入れた名前を、主催者が見分けられるように表示する

### Requirement 4: 会議の後で名前を直して書き出し直す
**Objective:** As a 会議の主催者, I want 会議が終わった後に話者の名前を直し、それを書き出しに反映できること, so that 共有する前に名前の誤りや抜けを直せる

#### Acceptance Criteria
1. When 主催者が終了したセッションの話者に名前を付ける・直す, the mindmap shall その名前をセッションの記録に残す
2. When 名前を直した後に主催者が書き出しを求めた, the mindmap shall 直した名前で map.md・map.json・map.html・map.drawnix を作り直す
3. When 主催者が見返しの画面（map.html を含む）を開いた, the mindmap shall 記録に残っている最新の名前で、マップ・字幕・根拠の発言を表示する
4. When 主催者がセッションを restore した, the mindmap shall 話者のラベルと名前を元のセッションと同じに戻す

### Requirement 5: 誰の決定かを持つ
**Objective:** As a 会議の主催者, I want 各決定に、それを口にした人が付くこと, so that 誰の決定かをマップと書き出しで読める

#### Acceptance Criteria
1. When 決定がマップに加わった, the mindmap shall 決定の根拠のうち最も早い発言の話者を、その決定の「決定を口にした人」とする
2. When 2 つの決定が統合された, the mindmap shall より早く言われたほうの決定を口にした人を残す
3. When 決定に根拠の発言が足された, the mindmap shall 決定を口にした人を変えない
4. If 決定を口にした人の発言に話者が無い（ラベルの無い「相手」）, the mindmap shall 決定を口にした人を「相手」として出す

### Requirement 6: 話者を表示する
**Objective:** As a 会議の主催者, I want 会議中の画面で、誰の発言・誰の決定かがひと目で分かること, so that 会議の流れを人と結び付けて追える

#### Acceptance Criteria
1. The mindmap shall マップの決定のノードに、決定を口にした人を出す
2. The mindmap shall マップの案のノードに出した人を、TODO のノードに担当者を、名前があれば名前で出す
3. When 主催者がノードの根拠の発言を開いた, the mindmap shall 各発言に話者（名前があれば名前）を出す
4. When 字幕に発言が出た, the mindmap shall その発言の話者（名前があれば名前）を字幕に出す
5. While 発言の話者がまだ決まっていない, the mindmap shall 字幕に仮の表示を出し、決まった時点で確定した話者に替える
6. The mindmap shall 話者ごとに見分けやすい表示（並びの位置や色など）にし、同じ話者はセッションを通じて同じ表示にする
7. Where 閲覧の共有で他の端末から見ている, the mindmap shall 他の端末にも同じ話者・名前を出す

### Requirement 7: 書き出しに話者を出す
**Objective:** As a 会議の主催者, I want 書き出したファイルにも誰の発言・誰の決定かが残ること, so that 議事録として共有したときに読み手が人を追える

#### Acceptance Criteria
1. When セッションを書き出した, the mindmap shall map.md の決定の行に、決定を口にした人を出す
2. When セッションを書き出した, the mindmap shall map.md の各ノードの根拠の時刻に、その発言の話者（名前があれば名前）を添える
3. When セッションを書き出した, the mindmap shall map.json の各発言に話者のラベルを、ファイル全体に話者のラベルと名前の対応を含める
4. When セッションを書き出した, the mindmap shall map.drawnix と map.html に、画面と同じ規則で話者・名前を出す
5. If 話者に名前が無い, the mindmap shall 書き出しではラベル（「自分」「相手 A」「相手」）で出す
