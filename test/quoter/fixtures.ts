import { ethers } from "hardhat"
import { Quoter } from "../../typechain"

interface QuoterFixture {
    quoter: Quoter
}

export function createQuoterFixture(clearingHouseAddr: string): () => Promise<QuoterFixture> {
    return async (): Promise<QuoterFixture> => {
        const quoterFactory = await ethers.getContractFactory("Quoter")
        const quoter = (await quoterFactory.deploy(clearingHouseAddr)) as Quoter

        return { quoter }
    }
}
