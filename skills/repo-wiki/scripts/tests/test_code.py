import pytest

import _code


@pytest.mark.parametrize(
    ("path", "text", "expected"),
    [
        ("a/OrderController.java",
         '@RestController\n@RequestMapping("/o")\nclass C {\n  @PostMapping\n  void f() {}\n}\n',
         [(1, "http"), (2, "http"), (4, "http")]),
        ("a/R.java", '@Path("/x")\npublic class R {}\n', [(1, "http")]),
        ("a/L.kt", '@KafkaListener(topics = ["t"])\nfun on() {}\n', [(1, "listener")]),
        ("a/J.java", "class J implements org.quartz.Job {}\n", [(1, "job")]),
        ("a/X.java", "class X { @XxlJob(\"sync\") void run() {} }\n", [(1, "job")]),
        ("a/S.java", "@DubboService\nclass S implements Api {}\n", [(1, "rpc")]),
        ("a/G.java", "class G extends OrderGrpc.OrderImplBase {}\n", [(1, "rpc")]),
        ("a/E.java", "class E { @TransactionalEventListener void on(E e) {} }\n", [(1, "event")]),
        ("a/Boot.java", "class Boot implements Serializable, CommandLineRunner {}\n", [(1, "startup")]),
        ("a/api.py", "@router.post('/orders')\ndef create():\n    pass\n", [(1, "http")]),
        ("a/views.py", "class Orders(viewsets.ModelViewSet):\n    pass\n", [(1, "http")]),
        ("a/urls.py", "urlpatterns = [\n    path('x/', v),\n    re_path(r'^y', v),\n]\n",
         [(2, "http"), (3, "http")]),
        ("a/tasks.py", "@shared_task(bind=True)\ndef retry(self):\n    pass\n", [(1, "job")]),
        ("a/tasks2.py", "@app.task\ndef go():\n    pass\n", [(1, "job")]),
        ("a/dag.py", "with DAG('etl') as dag:\n    pass\n", [(1, "job")]),
        ("a/cmd.py", "class Command(BaseCommand):\n    pass\n", [(1, "cli")]),
        ("a/cli.py", "@click.command()\ndef main():\n    pass\n", [(1, "cli")]),
        ("a/sig.py", "@receiver(post_save, sender=Order)\ndef on(sender, **kw):\n    pass\n", [(1, "event")]),
        ("a/c.ts", "@Controller('orders')\nexport class C {\n  @Get(':id')\n  one() {}\n}\n",
         [(1, "http"), (3, "http")]),
        ("a/server.js", "app.get('/health', h);\nrouter.post(`/x`, h);\n", [(1, "http"), (2, "http")]),
        ("a/cron.ts", "class C { @Cron('0 * * * *') tick() {} }\n", [(1, "job")]),
        ("a/main.go", 'func main() {\n\thttp.HandleFunc("/x", h)\n\tr.GET("/y", h)\n}\n',
         [(2, "http"), (3, "http")]),
        ("a/C.cs", "[ApiController]\npublic class C : ControllerBase {}\n", [(1, "http"), (2, "http")]),
    ],
)
def test_triggers_by_framework(path, text, expected):
    assert _code.triggers_in(path, text) == expected


@pytest.mark.parametrize(
    ("path", "text"),
    [
        # Comments, docstrings and (in brace languages) strings are not code.
        ("a/Doc.java", "/** Use {@code @GetMapping} here. */\nclass Doc { String s = \"@Scheduled\"; }\n"),
        ("a/doc.py", 'def f():\n    """\n    @router.get("/x")\n    """\n# @app.task\n'),
        ("a/c.ts", "// @Get('x')\nconst s = 1;\n"),
        # An outbound client describes calls to another service, not a trigger.
        ("a/InventoryClient.java", '@FeignClient("inventory")\ninterface I { @GetMapping("/x") String x(); }\n'),
        # Near misses: another annotation, a subclass, a non-route path() call.
        ("a/Adv.java", "@ControllerAdvice\nclass Adv {}\n"),
        ("a/J.java", "class J implements SomeJob {}\n"),
        ("a/p.py", "path('x')\n"),
        ("a/README.md", "@app.get('/x')\n"),
    ],
)
def test_non_triggers(path, text):
    assert _code.triggers_in(path, text) == []


def test_trigger_tokens_cover_every_rule():
    samples = {
        "http": ["@RestController", "@Path(", "@router.get(", "(APIView)", "@Get(", "app.get('/", '.GET("/',
                 "http.HandleFunc(", "[HttpGet]", ": Controller"],
        "rpc": ["@DubboService", "ImplBase", "add_XServicer_to_server("],
        "listener": ["@KafkaListener", "@RabbitHandler", "implements RocketMQListener", "@app.agent(",
                     "@EventPattern("],
        "job": ["@Scheduled", "@XxlJob", "extends QuartzJobBean", "implements Job", "@shared_task", "DAG(",
                "@Cron(", ".AddFunc(", ": BackgroundService"],
        "event": ["@EventListener", "@receiver(", "@OnEvent("],
        "cli": ["(BaseCommand)", "@click.command("],
        "startup": ["implements CommandLineRunner"],
    }
    for kind, texts in samples.items():
        for text in texts:
            assert any(token in text for token in _code.TRIGGER_TOKENS), (kind, text)


def _edges(imports):
    return {(a, b) for a, _, b in imports.edges()}


def test_imports_resolve_jvm_python_js_and_go():
    imports = _code.Imports()
    imports.root("")
    files = {
        "svc/src/main/java/com/x/order/Order.java": "package com.x.order;\nimport com.x.pay.Pay;\n"
                                                    "import static com.x.pay.Pay.MAX;\nimport com.x.common.*;\n"
                                                    "import java.util.List;\nclass Order {}\n",
        "svc/src/main/java/com/x/pay/Pay.java": "package com.x.pay;\nclass Pay {}\n",
        "svc/src/main/java/com/x/common/Ids.java": "package com.x.common;\nclass Ids {}\n",
        "src/shop/__init__.py": "",
        "src/shop/orders/__init__.py": "",
        "src/shop/orders/api.py": "import os\nfrom shop.billing import service\nfrom ..common import util\n"
                                  "import shop.billing.tasks as t\n",
        "src/shop/billing/__init__.py": "",
        "src/shop/billing/service.py": "from . import tasks\n",
        "src/shop/billing/tasks.py": "",
        "src/shop/common/util.py": "",
        "web/src/index.ts": "import { a } from './lib/a';\nimport ui from '@acme/ui/button';\n"
                            "const b = require('../../ui/x.js');\nimport 'react';\n",
        "web/src/lib/a.ts": "",
        "ui/x.js": "",
        "svc2/main.go": 'package main\nimport (\n\t"fmt"\n\tstore "example.com/svc2/store"\n)\n',
        "svc2/store/s.go": "package store\n",
    }
    imports.package("@acme/ui", "ui/package.json")
    imports.go_module("example.com/svc2", "svc2")
    for path, text in files.items():
        imports.add(path, text)
    assert _edges(imports) == {
        ("svc/src/main/java/com/x/order/Order.java", "svc/src/main/java/com/x/pay/Pay.java"),
        ("svc/src/main/java/com/x/order/Order.java", "svc/src/main/java/com/x/common/Ids.java"),
        ("src/shop/orders/api.py", "src/shop/billing/service.py"),
        ("src/shop/orders/api.py", "src/shop/common/util.py"),
        ("src/shop/orders/api.py", "src/shop/billing/tasks.py"),
        ("src/shop/billing/service.py", "src/shop/billing/tasks.py"),
        ("web/src/index.ts", "web/src/lib/a.ts"),
        ("web/src/index.ts", "ui/package.json"),
        ("web/src/index.ts", "ui/x.js"),
        ("svc2/main.go", "svc2/store/s.go"),
    }


def test_resources_name_topics_and_tables():
    java = (
        '@KafkaListener(topics = {"order-created", "order-paid"}, groupId = "g")\n'
        "void on() {}\n"
        'void f() { kafkaTemplate.send("order-created", x); }\n'
        '@Table(name = "T_ORDER")\n'
        'String q = "select o.id from shop.t_order o join t_customer c on c.id = o.cid";\n'
        'String msg = "Could not update from server";\n'
    )
    assert _code.resources_in("a/X.java", java) == [
        ("table", "t_customer", 5), ("table", "t_order", 4), ("table", "t_order", 5),
        ("topic", "order-created", 1), ("topic", "order-created", 3), ("topic", "order-paid", 1),
    ]
    python = "__tablename__ = 'orders'\ncur.execute('''\n  UPDATE orders SET x = 1\n''')\nKafkaConsumer('evt')\n"
    assert _code.resources_in("a/m.py", python) == [
        ("table", "orders", 1), ("table", "orders", 3), ("topic", "evt", 5),
    ]
    mapper = '<mapper namespace="x">\n<select id="a">SELECT * FROM t_order WHERE id = #{id}</select>\n</mapper>'
    assert _code.resources_in("r/OrderMapper.xml", mapper) == [("table", "t_order", 2)]
    assert _code.resources_in("r/pom.xml", "<project>select from x</project>") == []
    ddl = "CREATE TABLE IF NOT EXISTS invoice (id int);\nINSERT INTO invoice VALUES (1);\n"
    assert _code.resources_in("db/V1__init.sql", ddl) == [("table", "invoice", 1), ("table", "invoice", 2)]
