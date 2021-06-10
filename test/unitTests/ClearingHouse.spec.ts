import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Factory } from "../../typechain"
import { toWei } from "../helper/number"
import { clearingHouseFixture, deployERC20 } from "../shared/fixturesUT"

describe("ClearingHouse Spec", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000B"
    const POOL_C_ADDRESS = "0x000000000000000000000000000000000000000C"
    const DEFAULT_FEE = 3000
    let baseToken: TestERC20
    let clearingHouse: ClearingHouse
    let uniV3Factory: UniswapV3Factory
    let collateral: TestERC20
    let mockUniV3Factory: MockContract
    let admin: SignerWithAddress
    let alice: SignerWithAddress

    beforeEach(async () => {
        const _clearingHouseFixture = await waffle.loadFixture(clearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        uniV3Factory = _clearingHouseFixture.uniV3Factory
        baseToken = _clearingHouseFixture.baseToken
        collateral = _clearingHouseFixture.USDC

        mockUniV3Factory = await smockit(uniV3Factory)
        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        mockUniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        const accounts = await ethers.getSigners()
        admin = accounts[0]
        alice = accounts[1]

        collateral.mint(admin.address, toWei(10000))
    })

    describe("# addPool", () => {
        // @SAMPLE - addPool
        it("add a UniswapV3 pool and send an event", async () => {
            // check event has been sent
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE))
                .to.emit(clearingHouse, "PoolAdded")
                .withArgs(baseToken.address, DEFAULT_FEE, POOL_A_ADDRESS)

            expect(await clearingHouse.isPoolExisted(POOL_A_ADDRESS)).to.eq(true)
        })

        it("add multiple UniswapV3 pools", async () => {
            const baseToken2 = await deployERC20()
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)

            // mock the return address of `getPool`
            mockUniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return POOL_B_ADDRESS
            })
            await clearingHouse.addPool(baseToken.address, "10000")

            // mock the return address of `getPool`
            mockUniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return POOL_C_ADDRESS
            })
            await clearingHouse.addPool(baseToken2.address, DEFAULT_FEE)

            // verify isPoolExisted
            expect(await clearingHouse.isPoolExisted(POOL_A_ADDRESS)).to.eq(true)
            expect(await clearingHouse.isPoolExisted(POOL_B_ADDRESS)).to.eq(true)
            expect(await clearingHouse.isPoolExisted(POOL_C_ADDRESS)).to.eq(true)
        })

        it("force error, pool is not existent in uniswap v3", async () => {
            mockUniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return EMPTY_ADDRESS
            })
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_NEP")
        })

        it("force error, pool is existent in ClearingHouse", async () => {
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_EP")
        })
    })

    describe.only("# deposit", () => {
        let aliceInitCollateralBalance = 1000

        beforeEach(async () => {
            const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await collateral.connect(alice).approve(clearingHouse.address, amount)
        })

        // @SAMPLE - deposit
        it("alice deposit and sends an event", async () => {
            const amount = toWei(100, await collateral.decimals())

            // check event has been sent
            await expect(clearingHouse.connect(alice).deposit(amount))
                .to.emit(clearingHouse, "Deposited")
                .withArgs(collateral.address, alice.address, amount)

            // check collateral status
            expect(await clearingHouse.getCollateral(alice.address)).to.eq(amount)

            // check alice balance
            expect(await collateral.balanceOf(alice.address)).to.eq(toWei(900, await collateral.decimals()))
        })

        // TODO should we test against potential attack using EIP777?
    })
})
