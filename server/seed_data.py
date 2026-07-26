"""Initial profile data for a useful first-run demo."""

from __future__ import annotations

from schemas import ContextItem


SEED_PROFILE: list[ContextItem] = [
    ContextItem(type="fact", category="identity", key="full_name", value="Vasu Yogeshwar"),
    ContextItem(
        type="fact",
        category="identity",
        key="professional_email",
        value="vasu.yogeshwar@proton.me",
    ),
    ContextItem(
        type="fact",
        category="identity",
        key="personal_email",
        value="vasuyogeshwar@gmail.com",
    ),
    ContextItem(type="fact", category="identity", key="phone", value="+91 98765 43210"),
    ContextItem(type="fact", category="identity", key="city", value="Bengaluru, India"),
    ContextItem(
        type="fact",
        category="identity",
        key="linkedin",
        value="https://www.linkedin.com/in/vasuyogeshwar",
    ),
    ContextItem(
        type="fact",
        category="education",
        key="university",
        value="Manipal Institute of Technology",
    ),
    ContextItem(
        type="fact",
        category="education",
        key="degree",
        value="Bachelor of Technology in Computer Science and Engineering",
    ),
    ContextItem(type="fact", category="education", key="graduation_year", value="2025"),
    ContextItem(
        type="fact",
        category="experience",
        key="hyperverge",
        value="Worked on AI and compliance-automation products at HyperVerge.",
    ),
    ContextItem(
        type="fact",
        category="experience",
        key="current_startup",
        value="Currently building Swara, a context-aware assistant for form filling.",
    ),
    ContextItem(
        type="fact",
        category="skills",
        key="programming_languages",
        value="Python, TypeScript, JavaScript, SQL",
    ),
    ContextItem(
        type="fact",
        category="skills",
        key="ai_skills",
        value="Applied AI, LLM integrations, document processing, prompt engineering",
    ),
    ContextItem(
        type="fact",
        category="skills",
        key="engineering_skills",
        value="FastAPI, React, Supabase, REST APIs, automation",
    ),
    ContextItem(
        type="preference",
        category="preferences",
        key="writing_style",
        value="professional, natural, concise",
    ),
    ContextItem(
        type="preference",
        category="preferences",
        key="application_tone",
        value="Confident and specific, without exaggeration or buzzwords.",
    ),
    ContextItem(
        type="preference",
        category="preferences",
        key="job_preferences",
        value="Roles involving applied AI, developer tools, or automation.",
    ),
]
