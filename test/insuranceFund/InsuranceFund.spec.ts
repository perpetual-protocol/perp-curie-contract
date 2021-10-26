import { MockContract } from "@eth-optimism/smock"
import { loadFixture } from "@ethereum-waffle/provider"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { InsuranceFund, TestERC20 } from "../../typechain"
import { mockedInsuranceFundFixture } from "./fixtures"

describe("InsuranceFund Spec", () => {
    const [admin] = waffle.provider.getWallets()
    let vault: MockContract
    let usdc: TestERC20
    let insuranceFund: InsuranceFund

    beforeEach(async () => {
        const _fixture = await loadFixture(mockedInsuranceFundFixture)
        vault = _fixture.mockedVault
        usdc = _fixture.USDC
        insuranceFund = _fixture.insuranceFund
    })

    it("force error, invalid token address", async () => {
        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
        await expect(insuranceFund.initialize(admin.address)).to.be.revertedWith("IF_TNC")
    })

    it("force error, setBorrower but borrower is not a contract", async () => {
        await expect(insuranceFund.setBorrower(admin.address)).to.revertedWith("IF_BNC")
    })
    it("force error, borrow from invalid borrower (only vault)", async () => {
        await insuranceFund.setBorrower(vault.address)
        await expect(insuranceFund.borrow("10")).to.revertedWith("IF_OB")
    })

    it.skip("has a treasury")

    // TODO feature is not implemented yet.
    describe.skip("revenue sharing", () => {
        // TODO: if the insurance ratio formula is still based on the total open interest
        it("getTotalOpenInterest")

        it("setInsuranceRatioThreshold")

        describe("getInsuranceRatio", () => {
            it("insuranceRatio = vault.balanceOf(IF) / totalOpenInterestNotional")
        })
    })
})
