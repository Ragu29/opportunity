const express = require("express");
const serviceAuth = require("../middleware/serviceAuth");
const controller = require("../controller/opportunity");

const router = express.Router();

router.get("/products", serviceAuth, controller.products);
router.post("/create", serviceAuth, controller.create);
router.post("/order-placed", serviceAuth, controller.orderPlaced);
router.post("/retry", serviceAuth, controller.retry);
router.post("/save", serviceAuth, controller.save);
router.post("/drop", serviceAuth, controller.drop);
router.get("/drop-candidates/:productCode", serviceAuth, controller.dropCandidates);
router.get("/:productCode/:reqId", serviceAuth, controller.status);

module.exports = router;
