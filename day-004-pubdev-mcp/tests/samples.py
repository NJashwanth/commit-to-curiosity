"""Realistic (trimmed) pub.dev API payloads for tests."""


def package(name="dio", version="5.11.1", published="2026-09-04T02:46:21.721502Z", **extra):
    return {
        "name": name,
        "latest": {
            "version": version,
            "pubspec": {
                "name": name,
                "version": version,
                "description": "A powerful HTTP networking package,\nsupports Interceptors,\nand more.\n",
                "topics": ["http", "network"],
                "homepage": f"https://github.com/example/{name}",
                "repository": f"https://github.com/example/{name}/blob/main/{name}",
                "issue_tracker": f"https://github.com/example/{name}/issues",
                "environment": {"sdk": ">=2.18.0 <4.0.0"},
            },
            "published": published,
        },
        **extra,
    }


def score(points=160, likes=8373, downloads=5424731, publisher="flutter.cn", extra_tags=()):
    tags = [
        f"publisher:{publisher}",
        "sdk:dart",
        "sdk:flutter",
        "platform:android",
        "platform:ios",
        "platform:web",
        "is:null-safe",
        "is:dart3-compatible",
        "is:wasm-ready",
        "license:mit",
        "license:fsf-libre",
        "license:osi-approved",
        *extra_tags,
    ]
    return {
        "grantedPoints": points,
        "maxPoints": 160,
        "likeCount": likes,
        "downloadCount30Days": downloads,
        "tags": [t for t in tags if t],
    }


def metrics(sections=None):
    sections = sections or [
        {"id": "convention", "title": "Follow Dart file conventions", "grantedPoints": 30,
         "maxPoints": 30, "status": "passed"},
        {"id": "analysis", "title": "Pass static analysis", "grantedPoints": 40,
         "maxPoints": 50, "status": "partial"},
    ]
    return {"score": score(), "scorecard": {"panaReport": {"report": {"sections": sections}}}}


def search(*names, next_url=None):
    body = {"packages": [{"package": n} for n in names]}
    if next_url:
        body["next"] = next_url
    return body


def routes_for(name, version="1.0.0", published="2026-09-04T00:00:00Z", points=160, **score_kw):
    return {
        f"/api/packages/{name}": package(name, version, published),
        f"/api/packages/{name}/score": score(points=points, **score_kw),
    }
