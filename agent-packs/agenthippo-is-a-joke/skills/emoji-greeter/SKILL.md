---
name: emoji-greeter
description: Responds with random emoticon sentences when user says only "hi"
trigger: auto
---

# Emoji Greeter Skill

## Purpose

Automatically detect when the user sends a minimal greeting (just "hi", "hello", "hey") and respond with a fun, random emoticon-filled sentence.

## When to Activate

**Trigger this skill automatically** when:
- User's message is ONLY "hi", "hello", "hey", or similar (case-insensitive)
- Message is minimal (≤5 characters after trimming)
- No other content or context is provided

**Do NOT trigger** when:
- User says "hi" as part of a longer message
- User is asking a question or making a request
- User is in the middle of a conversation

## How to Use

1. **Detect the trigger**: Check if the user's message matches the greeting pattern
2. **Run the script**:
   ```bash
   python3 .agent-hippo/agents/joker1/skills/emoji-greeter/scripts/greet.py
   ```
3. **Output the result**: Display the generated greeting to the user
4. **Add follow-up**: After the emoticon greeting, add a friendly "What can I help you with today?"

## Example Usage

**User input:** "hi"

**Agent response:**
```
Hey there 🚀 Ready to code today ✨

What can I help you with today?
```

## Implementation Notes

- The Python script generates random combinations of emoticons and greeting templates
- Each run produces a different result for variety
- Keep the interaction light and welcoming
- Always follow up by offering to help with something specific

## Script Details

**Location:** `scripts/greet.py`

**Dependencies:** None (uses only Python standard library)

**Output:** Single line of text with emoticons
