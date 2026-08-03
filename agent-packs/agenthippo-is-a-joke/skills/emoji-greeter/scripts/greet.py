#!/usr/bin/env python3
"""Generate random emoticon greeting sentences."""

import random

EMOTICONS = ["😊", "🎉", "🚀", "✨", "🌟", "💡", "🎨", "🔥", "⚡", "🌈", "🎯", "💪", "🤖", "👋", "🎭"]

TEMPLATES = [
    "Hey there {emoji} Ready to code today {emoji}",
    "Hello {emoji} Let's build something awesome {emoji}",
    "Greetings {emoji} What can I help you with {emoji}",
    "Hi {emoji} Time to make magic happen {emoji}",
    "Howdy {emoji} Let's solve some problems {emoji}",
    "Welcome back {emoji} Ready for some fun {emoji}",
    "Hey {emoji} Let's get creative {emoji}",
    "Hello friend {emoji} What's on your mind {emoji}",
]

def generate_greeting():
    """Generate a random emoticon greeting."""
    template = random.choice(TEMPLATES)
    emoji1 = random.choice(EMOTICONS)
    emoji2 = random.choice(EMOTICONS)
    return template.format(emoji=emoji1) + emoji2

if __name__ == "__main__":
    print(generate_greeting())
