---
title: Related Work
doc: [[2025.emnlp-main.893]]
page: 2
kind: paper
section: Related Work
---

![[page-002.png]]

# 2 Related Work

## 2.1 Document Question Answering
DQA (Document Question Answering) 的發展主要遵循兩條路徑。第一種利用 OCR 提取文件文本，並通常整合視覺特徵以強化答案預測。例如 LayoutLM (Xu et al., 2020, 2021; Huang et al., 2022) 整合了 OCR 提取的文本與視覺嵌入用於文件理解任務。第二種則是跳過 OCR 階段，採用端到端學習範式 (end-to-end learning paradigm) (Kim et al., 2022; Lee et al., 2023)。近期研究 (Hu et al., 2024; Rasol et al., 2024) 利用 LLM 的能力來賦能 DQA。

**Our contributions can be summarized as follows:**
* We propose a novel multi-modal agent framework that leverages a tree-structured outline and retrieval tools to identify and extract relevant document content efficiently.
* We introduce a reviewer agent that verifies and enhances answers by incorporating information from complementary sources.
* We develop a task-agnostic memory bank that enables the agent to learn from prior experience, improving performance across tasks.
* We conduct experiments on two long-context multi-modal understanding benchmarks and perform ablation studies to validate the effectiveness of our proposed method.

## 2.2 LLM Agents
LLM agents 與其環境互動以達成任務目標。ReAct (Yao et al., 2023) 提出了引入推理鏈 (chain-of-thought) 與行動的機制，以減少錯誤傳播。此外，多模態 LLMs (Hurt et al., 2024) 與檢索增強型 LLMs (Saul-Falcon et al., 2024) 分別在不同方向進行研究。Zhou et al., 2024 提出了關於先前軌跡 (previous trajectories) 的研究。本研究方法的新穎之處在於引入了一個 novel reflection module，用於處理與代理人 (actor) 之間的軌跡，從中獲取洞察。

## 2.3 Enhancing LLM Efficiency for Long Contexts
由於 Transformer 的複雜度隨序列長度呈平方級增長 (quadratically with sequence length)，研究者正致力於優化長文本的 LLM 效率。例如：MARG (D'Arcy et al., 2024) 利用一個多代理人框架將長文本內容切分。
