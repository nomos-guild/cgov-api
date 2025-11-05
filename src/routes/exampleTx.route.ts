import express from 'express';
import { exampleTxController } from '../controllers';
import { buildTx, submitTx } from '../middleware/exampleTx.validation';

const router = express.Router();

router.post('/build', buildTx.validateParam, exampleTxController.buildTx)

router.post('/submit', submitTx.validateParam, exampleTxController.submitTx)

export default router;
