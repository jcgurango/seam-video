"""Response schemas. Lifted into OpenAPI by FastAPI for the contract doc."""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class Word(BaseModel):
    start: float = Field(description="Word start time in seconds")
    end: float = Field(description="Word end time in seconds")
    text: str = Field(description="Word text, including any leading whitespace stripped")


class Segment(BaseModel):
    start: float = Field(description="Segment start time in seconds")
    end: float = Field(description="Segment end time in seconds")
    text: str = Field(description="Segment text (concatenation of its words)")
    words: List[Word] = Field(default_factory=list)


# `TranscriptionResponse` is just `list[Segment]`; declared as an alias for
# OpenAPI clarity.
TranscriptionResponse = List[Segment]
