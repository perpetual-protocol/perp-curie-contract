import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20 } from "../../typechain"
import { toWei } from "../helper/number"
import { clearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    let admin: SignerWithAddress
    let alice: SignerWithAddress
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20

    beforeEach(async () => {
        const _clearingHouseFixture = await waffle.loadFixture(clearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.vUSDC

        // assign accounts
        const accounts = await ethers.getSigners()
        admin = accounts[0]
        alice = accounts[1]

        // mint
        collateral.mint(admin.address, toWei(10000))
    })

    describe("# deposit", () => {
        const aliceInitCollateralBalance = 1000

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

    describe("# mint", () => {
        const aliceInitCollateralBalance = 1000

        beforeEach(async () => {
            // prepare collateral
            const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await collateral.connect(alice).approve(clearingHouse.address, amount)
            await clearingHouse.connect(alice).deposit(amount)

            // add pool
            await clearingHouse.addPool(baseToken.address, 3000)
        })

        it("alice mint quote and sends an event", async () => {
            // assume imRatio = 0.1
            // alice collateral=1000, mint 10000 quote
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, 0, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, 0, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await quoteToken.decimals()))
            // verify free collateral = 1000 / 0.1 - 10000 = 0
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint base and sends an event", async () => {
            // alice collateral=1000, mint 10 base @ price=100
        })

        it("alice mint both and sends an event", async () => {})

        it("force error, alice mint too many quote", async () => {})

        it("force error, alice mint too many base", async () => {})

        it("force error, alice mint base without specifying baseToken", async () => {})
    })
})
