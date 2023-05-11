pragma solidity 0.7.6;
pragma abicoder v2;

import "../helper/Setup.sol";
import "../helper/Constant.sol";
import { IClearingHouseConfigEvent } from "../../../contracts/interface/IClearingHouseConfig.sol";

contract ClearingHouseConfigTest is IClearingHouseConfigEvent, Setup, Constant {
    function setUp() public virtual override {
        Setup.setUp();
    }

    // setLiquidationPenaltyRatio

    function test_setLiquidationPenaltyRatio_should_emit_event(uint24 liquidationPenaltyRatio) public {
        vm.assume(liquidationPenaltyRatio <= MAX_RATIO);

        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatio);
        clearingHouseConfig.setLiquidationPenaltyRatio(liquidationPenaltyRatio);

        assertEq(uint256(liquidationPenaltyRatio), clearingHouseConfig.getLiquidationPenaltyRatio());
    }

    function test_revert_setLiquidationPenaltyRatio_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setLiquidationPenaltyRatio(0);
    }

    function test_revert_setLiquidationPenaltyRatio_ratio_overflows() public {
        vm.expectRevert(bytes("CHC_RO"));
        clearingHouseConfig.setLiquidationPenaltyRatio(MAX_RATIO + 1);
    }

    // setTwapInterval

    function test_setTwapInterval_as_non_zero_should_emit_event(uint32 twapInterval) public {
        vm.assume(twapInterval != 0);

        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit TwapIntervalChanged(twapInterval);
        clearingHouseConfig.setTwapInterval(twapInterval);

        assertEq(uint256(twapInterval), clearingHouseConfig.getTwapInterval());
    }

    function test_setTwapInterval_as_zero_should_emit_event() public {
        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit TwapIntervalChanged(0);
        clearingHouseConfig.setTwapInterval(0);

        assertEq(uint256(0), clearingHouseConfig.getTwapInterval());
    }

    function test_revert_setTwapInterval_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setTwapInterval(1);
    }

    // setMaxMarketsPerAccount

    function test_setMaxMarketsPerAccount_should_emit_event(uint8 maxMarketsPerAccount) public {
        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit MaxMarketsPerAccountChanged(maxMarketsPerAccount);
        clearingHouseConfig.setMaxMarketsPerAccount(maxMarketsPerAccount);

        assertEq(uint256(maxMarketsPerAccount), clearingHouseConfig.getMaxMarketsPerAccount());
    }

    function test_revert_setMaxMarketsPerAccount_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setMaxMarketsPerAccount(0);
    }

    // setSettlementTokenBalanceCap

    function test_setSettlementTokenBalanceCap_should_emit_event(uint8 cap) public {
        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit SettlementTokenBalanceCapChanged(cap);
        clearingHouseConfig.setSettlementTokenBalanceCap(cap);

        assertEq(uint256(cap), clearingHouseConfig.getSettlementTokenBalanceCap());
    }

    function test_revert_setSettlementTokenBalanceCap_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setSettlementTokenBalanceCap(0);
    }

    // setMarkPriceMarketTwapInterval

    function test_setMarkPriceMarketTwapInterval_should_emit_event(uint32 newMarketTwapInterval) public {
        vm.assume(newMarketTwapInterval != 0);

        (, uint32 premiumIntervalBefore) = clearingHouseConfig.getMarkPriceConfig();
        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit MarkPriceMarketTwapIntervalChanged(newMarketTwapInterval);
        clearingHouseConfig.setMarkPriceMarketTwapInterval(newMarketTwapInterval);

        (uint32 marketTwapIntervalAfter, uint32 premiumIntervalAfter) = clearingHouseConfig.getMarkPriceConfig();
        assertEq(uint256(marketTwapIntervalAfter), newMarketTwapInterval);
        assertEq(uint256(premiumIntervalAfter), premiumIntervalBefore);
    }

    function test_revert_setMarkPriceMarketTwapInterval_if_interval_is_zero() public {
        vm.expectRevert(bytes("CHC_IMPMTI"));
        clearingHouseConfig.setMarkPriceMarketTwapInterval(0);
    }

    function test_revert_setMarkPriceMarketTwapInterval_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setMarkPriceMarketTwapInterval(60);
    }

    // setMarkPricePremiumInterval

    function test_setMarkPricePremiumInterval_should_emit_event(uint32 newPremiumInterval) public {
        vm.assume(newPremiumInterval != 0);

        (uint32 marketTwapIntervalBefore, ) = clearingHouseConfig.getMarkPriceConfig();
        vm.expectEmit(false, false, false, true, address(clearingHouseConfig));
        emit MarkPricePremiumIntervalChanged(newPremiumInterval);
        clearingHouseConfig.setMarkPricePremiumInterval(newPremiumInterval);

        (uint32 marketTwapIntervalAfter, uint32 premiumIntervalAfter) = clearingHouseConfig.getMarkPriceConfig();
        assertEq(uint256(marketTwapIntervalAfter), marketTwapIntervalBefore);
        assertEq(uint256(premiumIntervalAfter), newPremiumInterval);
    }

    function test_revert_setMarkPricePremiumInterval_if_interval_is_zero() public {
        vm.expectRevert(bytes("CHC_IMPPI"));
        clearingHouseConfig.setMarkPricePremiumInterval(0);
    }

    function test_revert_setMarkPricePremiumInterval_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setMarkPricePremiumInterval(60);
    }
}
