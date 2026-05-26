import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetDRepVerifyResponse } from "../../responses";
import { getDrepInfoBatch } from "../../services/drep-lookup";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { normalizeDrepIdToCip129 } from "../../utils/drep-id";

export const getDRepVerify = async (req: Request, res: Response) => {
  try {
    const rawDrepId = req.params.drepId as string;

    if (!rawDrepId) {
      return res.status(400).json({
        error: "Missing drepId",
        message: "A drepId path parameter is required",
      });
    }

    const drepId = normalizeDrepIdToCip129(rawDrepId);

    const drep = await prisma.drep.findUnique({
      where: { drepId },
      select: {
        drepId: true,
        registered: true,
        active: true,
        expiresEpoch: true,
      },
    });

    if (drep) {
      // Koios sometimes omits `registered` in /drep_info responses even when the
      // DRep has a current registration. In that case the column ends up null
      // and `!!null` would wrongly report "not registered". `active === true`
      // combined with a populated `expiresEpoch` is on-chain proof of a current
      // registration (both fields are derived from registration certs).
      const isRegistered =
        !!drep.registered || (!!drep.active && drep.expiresEpoch != null);

      const response: GetDRepVerifyResponse = {
        drepId,
        exists: true,
        isRegistered,
        isActive: !!drep.active,
        expiresEpoch: drep.expiresEpoch ?? null,
        source: "db",
      };

      return res.json(response);
    }

    const lookupResults = await prisma.$transaction((tx) =>
      getDrepInfoBatch(tx, [drepId])
    );
    const fetched = lookupResults[0];

    const isRegistered =
      !!fetched?.registered ||
      (!!fetched?.active && fetched?.expiresEpoch != null);

    const response: GetDRepVerifyResponse = {
      drepId,
      exists: !!fetched,
      isRegistered,
      isActive: !!fetched?.active,
      expiresEpoch: fetched?.expiresEpoch ?? null,
      source: fetched ? "koios" : undefined,
    };

    return res.json(response);
  } catch (error) {
    console.error("Error verifying DRep", formatAxiosLikeError(error));
    return res.status(500).json({
      error: "Failed to verify DRep",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
