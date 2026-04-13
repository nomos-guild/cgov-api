import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetDRepVerifyResponse } from "../../responses";
import { getDrepInfoBatch } from "../../services/drep-lookup";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

export const getDRepVerify = async (req: Request, res: Response) => {
  try {
    const drepId = req.params.drepId as string;

    if (!drepId) {
      return res.status(400).json({
        error: "Missing drepId",
        message: "A drepId path parameter is required",
      });
    }

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
      const response: GetDRepVerifyResponse = {
        drepId,
        exists: true,
        isRegistered: !!drep.registered,
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

    const response: GetDRepVerifyResponse = {
      drepId,
      exists: !!fetched,
      isRegistered: !!fetched?.registered,
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
