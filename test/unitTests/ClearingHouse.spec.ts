import { MockContract, smockit } from "@eth-optimism/smock"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse } from "../../typechain"
import { UniswapV3Pool } from "../../typechain/uniswap"
import { clearingHouseFixture } from "../shared/fixturesUT"

describe("ClearingHouse UT", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000001"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000a"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000b"
    let clearingHouse: ClearingHouse
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await waffle.loadFixture(clearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        uniV3Factory = _clearingHouseFixture.mockUniV3Factory
    })

    // @SAMPLE - addPool
    it("add a UniswapV3 pool and verify event", async () => {
        // check the pool has been added into mapping
        const mockedPool = await createMockedPool(uniV3Factory.address, POOL_A_ADDRESS)

        // check event has been sent
        await expect(clearingHouse.addPool(mockedPool.address))
            .to.emit(clearingHouse, "PoolAdded")
            .withArgs(mockedPool.address)
        expect(await clearingHouse.poolMap(mockedPool.address)).to.eq(true)
    })

    it("add multiple UniswapV3 pools", async () => {
        // check the pool has been added into mapping
        const mockedPool1 = await createMockedPool(uniV3Factory.address, POOL_A_ADDRESS)
        const mockedPool2 = await createMockedPool(uniV3Factory.address, POOL_B_ADDRESS)

        // add pools to clearingHouse
        await clearingHouse.addPool(mockedPool1.address)
        await clearingHouse.addPool(mockedPool2.address)

        // verify poolMap
        expect(await clearingHouse.poolMap(mockedPool1.address)).to.eq(true)
        expect(await clearingHouse.poolMap(mockedPool2.address)).to.eq(true)
    })

    it("force error, pool is existent in ClearingHouse", async () => {
        const mockedPool = await createMockedPool(uniV3Factory.address, POOL_A_ADDRESS)
        await clearingHouse.addPool(mockedPool.address)
        await expect(clearingHouse.addPool(mockedPool.address)).to.be.revertedWith("CH_EP")
    })

    it("force error, pool is not existent in uniswap v3", async () => {
        const mockedPool = await createMockedPool(uniV3Factory.address, POOL_A_ADDRESS)
        // mock pool's factory to another address
        mockedPool.smocked.factory.will.return.with(EMPTY_ADDRESS)
        // should revert because pool's factory != uniV3Factory
        await expect(clearingHouse.addPool(mockedPool.address)).to.be.revertedWith("CH_NEP")
    })
})

async function createMockedPool(uniV3FactoryAddr: string, poolAddr: string): Promise<MockContract> {
    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddr) as UniswapV3Pool

    // mock pool and set factory to uniV3Factory
    const mockedPool = await smockit(pool)
    mockedPool.smocked.factory.will.return.with(uniV3FactoryAddr)

    return mockedPool
}
