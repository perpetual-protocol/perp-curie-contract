pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import { IClearingHouseConfigEvent } from "../interface/IClearingHouseConfigEvent.sol";

contract ClearingHouseConfigTest is IClearingHouseConfigEvent, Setup {
    address public nonOwnerAddress = makeAddr("nonOwnerAddress");

    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_setMarkPriceMarketTwapInterval_should_emit_event(uint32 newInterval) public {
        vm.assume(newInterval != 0);
        vm.expectEmit(true, false, false, true, address(clearingHouseConfig));
        emit MarkPriceMarketTwapIntervalChanged(newInterval);
        clearingHouseConfig.setMarkPriceMarketTwapInterval(newInterval);
        assertEq(uint256(clearingHouseConfig.getMarkPriceMarketTwapInterval()), uint256(newInterval));
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

    function test_setMarkPricePremiumInterval_should_emit_event(uint32 newInterval) public {
        vm.assume(newInterval != 0);
        vm.expectEmit(true, false, false, true, address(clearingHouseConfig));
        emit MarkPricePremiumIntervalChanged(newInterval);
        clearingHouseConfig.setMarkPricePremiumInterval(newInterval);
        assertEq(uint256(clearingHouseConfig.getMarkPricePremiumInterval()), uint256(newInterval));
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
